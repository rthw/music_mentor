#!/usr/bin/env bash
# Завести ученика на сервере наставника (контейнер из tools/vps) и собрать для него zip под Win7 (T1938, T1940).
#   tools/vps/new_learner.sh <имя> [--url https://present.whimsical.work/mentor] [--container C]
# В контейнере: unix-пользователь в группе mentors, рабочая папка из template/, пакет music_mentor
# (`pi install`), settings.json и auth.json (ключ DeepSeek из `secret run deepseek_music_mentor`, не печатается),
# свой порт моста (9901, 9902, …) и токен (32 случайных байта): на сервере только его sha256 (/home/.mm/learners),
# сам токен — в zip (адрес веб-терминала и mentor_remote.json для моста). Результат: ~/.cache/music_mentor/bundles/<имя>.zip.
# Повторный запуск для того же имени — новый токен (старый перестаёт работать, ссылка и мост из прежнего zip тоже).
#
# Переменные (для тестов): MM_CONTAINER, MM_BUNDLES_DIR, MM_WIN7_ASSETS (vc_redist.x64.exe), MM_SKIP_ASSET_SHA=1,
# MM_DEEPSEEK_KEY (если задан — `secret` не зовём), MM_PKG_SRC (откуда брать пакет, по умолчанию репо), MM_PUBLIC_URL.
set -euo pipefail

SECRET_NAME="deepseek_music_mentor"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN7="$ROOT/tools/vps/win7"
CONTAINER="${MM_CONTAINER:-mm_vps}"
PUBLIC_URL="${MM_PUBLIC_URL:-https://present.whimsical.work/mentor}"
BUNDLES="${MM_BUNDLES_DIR:-$HOME/.cache/music_mentor/bundles}"
ASSETS="${MM_WIN7_ASSETS:-$HOME/.cache/music_mentor/win7_assets}"
PKG_DIR=/opt/music_mentor_pkg
FIRST_PORT=9901

die() { echo "new_learner: $*" >&2; exit 1; }

# --- внутренний режим: уже под `secret run`, ключ в переменной окружения ---------------------------------
if [ "${1:-}" = "--inner" ]; then shift; fi

name=""
while [ $# -gt 0 ]; do
	case "$1" in
		--url) PUBLIC_URL="${2:?}"; shift 2 ;;
		--container) CONTAINER="${2:?}"; shift 2 ;;
		-h|--help) sed -n 2,11p "$0"; exit 0 ;;
		-*) die "неизвестный параметр $1" ;;
		*) [ -z "$name" ] || die "имя одно"; name="$1"; shift ;;
	esac
done
[ -n "$name" ] || die "нужно имя ученика: new_learner.sh <имя> [--url U]"
[[ "$name" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "имя: латиница, цифры, _; начинается с буквы (например ivan2)"
[ "$name" != "root" ] || die "имя занято"

command -v docker >/dev/null || die "нужен docker"
docker exec "$CONTAINER" true 2>/dev/null || die "контейнер $CONTAINER не запущен (tools/vps/run_container.sh; см. tools/vps/README.md)"

# --- ключ DeepSeek: только из secret, и только в дочернем процессе ---------------------------------------
if [ -z "${MM_DEEPSEEK_KEY:-}" ]; then
	if [ -n "${!SECRET_NAME:-}" ]; then
		MM_DEEPSEEK_KEY="${!SECRET_NAME}"
	else
		secret list 2>/dev/null | grep -qx "$SECRET_NAME" || die "в хранилище нет ключа $SECRET_NAME (secret set $SECRET_NAME)"
		exec secret run "$SECRET_NAME" -- "$0" --inner "$name" --url "$PUBLIC_URL" --container "$CONTAINER"
	fi
fi
[ "${#MM_DEEPSEEK_KEY}" -ge 8 ] || die "ключ DeepSeek пуст"

# --- ресурсы для zip ---------------------------------------------------------------------------------------
for f in vc_redist.x64.exe; do
	[ -f "$ASSETS/$f" ] || die "нет $ASSETS/$f (vc_redist 14.44 x64; см. tools/vps/README.md)"
done
if [ -z "${MM_SKIP_ASSET_SHA:-}" ]; then
	(cd "$ASSETS" && sha256sum --quiet -c "$WIN7/assets.sha256") || die "контрольная сумма vc_redist.x64.exe не сошлась"
fi

# --- адрес: https, иначе токен уйдёт открытым текстом ----------------------------------------------------
[[ "$PUBLIC_URL" == https://* || "$PUBLIC_URL" == http://127.0.0.1* || "$PUBLIC_URL" == http://localhost* ]] || die "--url должен быть https://…"
PUBLIC_URL="${PUBLIC_URL%/}"

# --- пакет music_mentor в контейнере (общий, читается всеми) ---------------------------------------------
src="${MM_PKG_SRC:-$ROOT}"
tmp_pkg="$(mktemp -d)"
trap 'rm -rf "$tmp_pkg"' EXIT
if git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
	# tracked + новые неигнорируемые файлы рабочей копии: тестируем то, что сейчас в репо, а не только HEAD
	(cd "$src" && git ls-files -co --exclude-standard -z | grep -zv '^docs/visual/' | tar --null -T - -cf -) | tar -C "$tmp_pkg" -xf -
else
	cp -r "$src/." "$tmp_pkg/"
fi
# PKG_DIR — том контейнера (переживает пересоздание): содержимое меняем, сам каталог не удаляем
docker exec "$CONTAINER" mkdir -p "$PKG_DIR"
docker exec "$CONTAINER" find "$PKG_DIR" -mindepth 1 -delete
tar -C "$tmp_pkg" -cf - . | docker exec -i "$CONTAINER" tar -C "$PKG_DIR" -xf -
docker exec "$CONTAINER" sh -c "chown -R root:root '$PKG_DIR' && chmod -R a+rX,go-w '$PKG_DIR'"

# --- пользователь, папка, настройки ----------------------------------------------------------------------
docker cp "$ROOT/tools/vps/mm_provision.mjs" "$CONTAINER:/usr/local/lib/mm_provision.mjs"
docker exec "$CONTAINER" sh -c "id '$name' >/dev/null 2>&1 || useradd -m -s /bin/bash -G mentors '$name'"
docker exec "$CONTAINER" sh -c "usermod -aG mentors '$name'"
home="$(docker exec "$CONTAINER" sh -c "getent passwd '$name' | cut -d: -f6")"

# порт моста на сервере: свой у каждого, существующему — прежний
bport="$(docker exec "$CONTAINER" sh -c "cat '$home/.mm_bridge_port' 2>/dev/null || true" | tr -dc '0-9')"
if [ -z "$bport" ]; then
	used="$(docker exec "$CONTAINER" sh -c 'cat /home/*/.mm_bridge_port 2>/dev/null || true' | tr -dc '0-9\n')"
	bport=$FIRST_PORT
	while printf '%s\n' "$used" | grep -qx "$bport"; do bport=$((bport + 1)); done
fi

docker exec -i -u "$name" -e HOME="$home" "$CONTAINER" sh -s "$home" "$bport" "$PKG_DIR" <<'EOS'
set -e
home="$1"; bport="$2"; pkg="$3"
echo "$bport" > "$home/.mm_bridge_port"
mkdir -p "$home/music_mentor"
cp -rn "$pkg/template/." "$home/music_mentor/"
mkdir -p "$home/.pi/agent"
export HOME="$home" PI_SKIP_VERSION_CHECK=1
cd "$home/music_mentor"
pi install "$pkg" >/dev/null
EOS
# settings.json: поля pi (packages от install) сохраняются; auth.json — ключ только через stdin
printf '%s' "$MM_DEEPSEEK_KEY" | docker exec -i -u "$name" -e HOME="$home" "$CONTAINER" \
	node /usr/local/lib/mm_provision.mjs --home "$home" --key-stdin >/dev/null

# --- токен: 32 случайных байта, на сервере только sha256 ---------------------------------------------------
out="$(mktemp -d)"
trap 'rm -rf "$tmp_pkg" "$out"' EXIT
token="$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=\n')"
[ "${#token}" -ge 43 ] || die "не получил токен"
uid="$(docker exec "$CONTAINER" id -u "$name")"
printf '%s' "$token" | docker exec -i "$CONTAINER" node /usr/local/lib/mm_relay.mjs --register --name "$name" --uid "$uid" --port "$bport" >/dev/null

# --- zip ------------------------------------------------------------------------------------------------------
stage="$out/$name"
mkdir -p "$stage/MentorBridge"
cp "$ASSETS/vc_redist.x64.exe" "$stage/"
(cd "$ROOT/bridge/MentorBridge" && find . -type f -name '*.py' -print0 | tar --null -T - -cf -) | tar -C "$stage/MentorBridge" -xf -
# мост читает эти {url, token}; в таком виде Python 2.7 Live 10 разбирает файл без сюрпризов
printf '{\r\n  "url": "%s",\r\n  "token": "%s"\r\n}\r\n' "$PUBLIC_URL" "$token" > "$stage/mentor_remote.json"
printf '%s/t/%s/\r\n' "$PUBLIC_URL" "$token" > "$stage/mentor_url.txt"
render() { # шаблон -> файл с CRLF
	sed -e "s|{{USER}}|$name|g" -e "s|{{URL}}|$PUBLIC_URL/t/$token/|g" "$1" | sed 's/$/\r/'
}
sed 's/$/\r/' "$WIN7/install_win7.cmd" > "$stage/install_win7.cmd"
sed 's/$/\r/' "$WIN7/win7_shortcut.ps1" > "$stage/win7_shortcut.ps1"
# README для Блокнота Win7: UTF-8 с BOM, CRLF. Адрес с токеном в README не пишем: он лежит в ярлыке.
{ printf '\xef\xbb\xbf'; render "$WIN7/README.txt.tmpl"; } > "$stage/README.txt"

mkdir -p "$BUNDLES"
rm -f "$BUNDLES/$name.zip"
(cd "$out" && zip -qrX "$BUNDLES/$name.zip" "$name")
chmod 600 "$BUNDLES/$name.zip"
echo "готово: $BUNDLES/$name.zip (ученик $name, порт моста $bport, $PUBLIC_URL)"
