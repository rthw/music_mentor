#!/usr/bin/env bash
# Собрать и выложить открытку в ~/.local/share/present/www (раздаёт present_site.service → present.whimsical.work).
#   tools/present/publish.sh [тег]   # по умолчанию тег из lib/win/versions.json
# Нужны секреты: deepseek_music_mentor (отдельный ключ друга) и present_password.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tag="${1:-$(node -e 'console.log(require(process.argv[1]).tag)' "$ROOT/lib/win/versions.json")}"
for s in deepseek_music_mentor present_password; do
	secret list 2>/dev/null | grep -qx "$s" || { echo "publish: нет секрета $s — secret set $s" >&2; exit 1; }
done
out="$HOME/.local/share/present/www"
secret run deepseek_music_mentor present_password -- node "$ROOT/tools/present/build.mjs" "$tag" "$out"
code=$(curl -s -o /dev/null -w "%{http_code}" https://present.whimsical.work/ || true)
echo "publish: https://present.whimsical.work/ -> HTTP $code"
