#!/usr/bin/env bash
# Выпуск версии наставника одной командой.
#   tools/release.sh 0.1.1          # только план, ничего не меняет (dry-run)
#   tools/release.sh 0.1.1 --yes    # тесты, правка версий, коммит, тег, push
#
# Версия живёт в трёх местах, и все три пишет этот скрипт:
#   lib/win/versions.json — "tag": источник для update.ps1 и tools/invite.sh;
#   install.ps1           — bootstrap-тег по умолчанию (install.ps1 не может скачать versions.json, пока не знает тег);
#   package.json          — version (для людей и npm).
# Совпадение bootstrap-тега с versions.json проверяет npm test.
#
# MM_RELEASE_TEST_CMD — чем проверять (по умолчанию `npm test`; тесты самого release.sh подставляют `true`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS="$ROOT/lib/win/versions.json"
INSTALL="$ROOT/install.ps1"
PACKAGE="$ROOT/package.json"
BRANCHES="main master"
TEST_CMD="${MM_RELEASE_TEST_CMD:-npm test}"

die() { echo "release: $*" >&2; exit 1; }

version="${1:-}"
[ -n "$version" ] || die "нужна версия: tools/release.sh 0.1.1 [--yes]"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "версия должна быть X.Y.Z (получено '$version')"
tag="v$version"
yes=0
for arg in "${@:2}"; do
	case "$arg" in
		--yes) yes=1 ;;
		*) die "неизвестный ключ '$arg' (есть только --yes)" ;;
	esac
done

command -v git >/dev/null || die "нужен git"
command -v python3 >/dev/null || die "нужен python3"

# --- проверки перед выпуском -------------------------------------------------
branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
case " $BRANCHES " in
	*" $branch "*) ;;
	*) die "выпускать можно только с ветки: $BRANCHES (сейчас '$branch')" ;;
esac
dirty="$(git -C "$ROOT" status --porcelain)"
[ -z "$dirty" ] || { echo "$dirty" >&2; die "дерево не чистое — сначала закоммить или убери правки"; }

cur_tag="$(python3 - "$VERSIONS" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["tag"])
PY
)"
cur_pkg="$(python3 - "$PACKAGE" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)"

if [ "$yes" -eq 0 ]; then
	cat <<EOF
План выпуска (это dry-run: ничего не меняю).

  ветка:       $branch, дерево чистое
  версии:      $cur_tag -> $tag (package.json: $cur_pkg -> $version)
  правлю:      lib/win/versions.json (tag)
               install.ps1 ($(basename "$INSTALL"): bootstrap-тег '$cur_tag' -> '$tag')
               package.json (version)
  команды:     1. $TEST_CMD
               2. git commit -m "release $tag"
               3. git tag -a $tag -m "$tag"
               4. git push origin $branch && git push origin $tag

После выпуска: прогнать установку на чистой Windows, потом отправить другу
  tools/invite.sh $tag

Для настоящего выпуска: tools/release.sh $version --yes
EOF
	exit 0
fi

echo "1/4 тесты: $TEST_CMD"
( cd "$ROOT" && eval "$TEST_CMD" )

echo "2/4 версии: $cur_tag -> $tag"
python3 - "$VERSIONS" "$PACKAGE" "$INSTALL" "$tag" "$version" <<'PY'
import json, re, sys

versions, package, install, tag, version = sys.argv[1:6]

def dump(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")

v = json.load(open(versions, encoding="utf-8"))
v["tag"] = tag
dump(versions, v)

p = json.load(open(package, encoding="utf-8"))
p["version"] = version
dump(package, p)

# install.ps1: тег по умолчанию в строке $MmTag. Без BOM (его читает irm | iex).
src = open(install, encoding="utf-8").read()
pat = re.compile(r"^(\$MmTag\s*=\s*if\s*\(\$env:MM_TAG\).*else\s*\{\s*')[^']+(')", re.M)
new, n = pat.subn(rf"\g<1>{tag}\g<2>", src)
if n != 1:
    sys.exit(f"не нашёл строку $MmTag в {install} (совпадений: {n})")
open(install, "w", encoding="utf-8", newline="").write(new)
PY

echo "3/4 commit и тег"
git -C "$ROOT" add -- lib/win/versions.json package.json install.ps1
git -C "$ROOT" commit -q -m "release $tag"
git -C "$ROOT" tag -a "$tag" -m "$tag"

echo "4/4 push"
git -C "$ROOT" push origin "$branch"
git -C "$ROOT" push origin "$tag"

cat <<EOF

Выпустил $tag. Дальше руками:
  1. прогнать установку на чистой Windows (install.ps1 с этим тегом);
  2. отправить другу строку: tools/invite.sh $tag
EOF
