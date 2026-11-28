#!/usr/bin/env bash
# Завести ученика на сервере наставника (контейнер из tools/vps) и собрать для него zip под Win7.
#   tools/vps/new_learner.sh <имя> [--host H] [--port P] [--container C]
# В контейнере: unix-пользователь в группе mentors, рабочая папка из template/, пакет music_mentor
# (`pi install`), settings.json и auth.json (ключ DeepSeek из `secret run deepseek_music_mentor`, не печатается),
# ключ ed25519 в authorized_keys + .ppk, свой порт туннеля к Live (9901, 9902, …).
# Результат: ~/.cache/music_mentor/bundles/<имя>.zip. Приватный ключ живёт только в zip: на диске автора
# и в контейнере после сборки его нет. Повторный запуск для того же имени — новый ключ (старый перестаёт работать).
#
# Переменные (для тестов): MM_CONTAINER, MM_BUNDLES_DIR, MM_WIN7_ASSETS (putty.exe, vc_redist.x64.exe),
# MM_SKIP_ASSET_SHA=1, MM_DEEPSEEK_KEY (если задан — `secret` не зовём), MM_PKG_SRC (откуда брать пакет, по умолчанию репо).
set -euo pipefail

SECRET_NAME="deepseek_music_mentor"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN7="$ROOT/tools/vps/win7"
CONTAINER="${MM_CONTAINER:-mm_vps_pilot}"
BUNDLES="${MM_BUNDLES_DIR:-$HOME/.cache/music_mentor/bundles}"
ASSETS="${MM_WIN7_ASSETS:-$HOME/.cache/music_mentor/win7_assets}"
PKG_DIR=/opt/music_mentor_pkg
FIRST_PORT=9901

die() { echo "new_learner: $*" >&2; exit 1; }

# --- внутренний режим: уже под `secret run`, ключ в переменной окружения ---------------------------------
if [ "${1:-}" = "--inner" ]; then shift; fi

name="" host="" port=22
while [ $# -gt 0 ]; do
	case "$1" in
		--host) host="${2:?}"; shift 2 ;;
		--port) port="${2:?}"; shift 2 ;;
		--container) CONTAINER="${2:?}"; shift 2 ;;
		-h|--help) sed -n 2,13p "$0"; exit 0 ;;
		-*) die "неизвестный параметр $1" ;;
		*) [ -z "$name" ] || die "имя одно"; name="$1"; shift ;;
	esac
done
[ -n "$name" ] || die "нужно имя ученика: new_learner.sh <имя> [--host H --port P]"
[[ "$name" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || die "имя: латиница, цифры, _; начинается с буквы (например ivan2)"
[ "$name" != "root" ] || die "имя занято"

command -v docker >/dev/null || die "нужен docker"
docker exec "$CONTAINER" true 2>/dev/null || die "контейнер $CONTAINER не запущен (docker build tools/vps; docker run …; см. tools/vps/README.md)"

# --- ключ DeepSeek: только из secret, и только в дочернем процессе ---------------------------------------
if [ -z "${MM_DEEPSEEK_KEY:-}" ]; then
	if [ -n "${!SECRET_NAME:-}" ]; then
		MM_DEEPSEEK_KEY="${!SECRET_NAME}"
	else
		secret list 2>/dev/null | grep -qx "$SECRET_NAME" || die "в хранилище нет ключа $SECRET_NAME (secret set $SECRET_NAME)"
		exec secret run "$SECRET_NAME" -- "$0" --inner "$name" ${host:+--host "$host"} --port "$port" --container "$CONTAINER"
	fi
fi
[ "${#MM_DEEPSEEK_KEY}" -ge 8 ] || die "ключ DeepSeek пуст"

# --- ресурсы для zip ---------------------------------------------------------------------------------------
for f in putty.exe vc_redist.x64.exe; do
	[ -f "$ASSETS/$f" ] || die "нет $ASSETS/$f (PuTTY 0.85 x64 и vc_redist 14.44 x64; см. tools/vps/README.md)"
done
if [ -z "${MM_SKIP_ASSET_SHA:-}" ]; then
	(cd "$ASSETS" && sha256sum --quiet -c "$WIN7/assets.sha256") || die "контрольные суммы putty.exe / vc_redist.x64.exe не сошлись"
fi

# --- адрес сервера -----------------------------------------------------------------------------------------
if [ -z "$host" ]; then
	host="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
	[ -n "$host" ] || die "не знаю адрес сервера: укажи --host"
	echo "new_learner: --host не задан, беру адрес контейнера $host (для пилота; для друга укажи внешний адрес)" >&2
fi

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
docker exec "$CONTAINER" rm -rf "$PKG_DIR"
docker exec "$CONTAINER" mkdir -p "$PKG_DIR"
tar -C "$tmp_pkg" -cf - . | docker exec -i "$CONTAINER" tar -C "$PKG_DIR" -xf -
docker exec "$CONTAINER" sh -c "chown -R root:root '$PKG_DIR' && chmod -R a+rX,go-w '$PKG_DIR'"

# --- пользователь, папка, настройки ----------------------------------------------------------------------
docker cp "$ROOT/tools/vps/mm_provision.mjs" "$CONTAINER:/usr/local/lib/mm_provision.mjs"
docker exec "$CONTAINER" sh -c "id '$name' >/dev/null 2>&1 || useradd -m -s /bin/bash -G mentors '$name'"
docker exec "$CONTAINER" sh -c "usermod -aG mentors '$name'"
home="$(docker exec "$CONTAINER" sh -c "getent passwd '$name' | cut -d: -f6")"

# порт туннеля: свой у каждого, существующему — прежний
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

# --- ключи: пара ed25519, публичная в authorized_keys, приватная — в .ppk -------------------------------
work="$(docker exec "$CONTAINER" mktemp -d)"
out="$(mktemp -d)"
cleanup() { docker exec "$CONTAINER" rm -rf "$work" 2>/dev/null || true; rm -rf "$tmp_pkg" "$out"; }
trap cleanup EXIT
docker exec "$CONTAINER" sh -c "
set -e
cd '$work'
ssh-keygen -q -t ed25519 -N '' -C '$name@music_mentor' -f k
puttygen k -O private -o '$name.ppk' >/dev/null
install -d -m 700 -o '$name' -g '$name' '$home/.ssh'
printf 'restrict,pty,port-forwarding,permitlisten=\"localhost:$bport\" %s\n' \"\$(cat k.pub)\" > '$home/.ssh/authorized_keys'
chown '$name:$name' '$home/.ssh/authorized_keys'; chmod 600 '$home/.ssh/authorized_keys'
shred -u k
"
docker cp "$CONTAINER:$work/$name.ppk" "$out/$name.ppk"
hostkey="$(docker exec "$CONTAINER" sh -c "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print \$2}'")"
[[ "$hostkey" == SHA256:* ]] || die "не получил отпечаток ключа сервера"

# --- zip ------------------------------------------------------------------------------------------------
stage="$out/$name"
mkdir -p "$stage/MentorBridge"
cp "$ASSETS/putty.exe" "$ASSETS/vc_redist.x64.exe" "$stage/"
mv "$out/$name.ppk" "$stage/$name.ppk"
(cd "$ROOT/bridge/MentorBridge" && find . -type f -name '*.py' -print0 | tar --null -T - -cf -) | tar -C "$stage/MentorBridge" -xf -
render() { # шаблон -> файл с CRLF
	sed -e "s|{{USER}}|$name|g" -e "s|{{HOST}}|$host|g" -e "s|{{PORT}}|$port|g" \
		-e "s|{{HOSTKEY}}|$hostkey|g" -e "s|{{BRIDGE_PORT}}|$bport|g" -e "s|{{PPK}}|$name.ppk|g" "$1" | sed 's/$/\r/'
}
render "$WIN7/start_mentor.cmd.tmpl" > "$stage/start_mentor.cmd"
sed 's/$/\r/' "$WIN7/install_win7.cmd" > "$stage/install_win7.cmd"
sed 's/$/\r/' "$WIN7/win7_shortcut.ps1" > "$stage/win7_shortcut.ps1"
# README для Блокнота Win7: UTF-8 с BOM, CRLF
{ printf '\xef\xbb\xbf'; render "$WIN7/README.txt.tmpl"; } > "$stage/README.txt"
# запуск без ярлыка: двойной щелчок. Имя ASCII: встроенный zip Win7 портит кириллицу в именах файлов.
mv "$stage/start_mentor.cmd" "$stage/Muzykalnyj nastavnik.cmd"

mkdir -p "$BUNDLES"
rm -f "$BUNDLES/$name.zip"
(cd "$out" && zip -qrX "$BUNDLES/$name.zip" "$name")
chmod 600 "$BUNDLES/$name.zip"
echo "готово: $BUNDLES/$name.zip (ученик $name, порт туннеля $bport, сервер $host:$port)"
