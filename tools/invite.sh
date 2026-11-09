#!/usr/bin/env bash
# Строка установки для друга -> в буфер обмена (wl-copy), в терминал не печатается.
# Ключ берётся из хранилища `secret` под именем deepseek_music_mentor (отдельный ключ для друга).
# Свой ключ автора сюда не подставляется.
#   tools/invite.sh [тег]        # по умолчанию тег из install.ps1
set -euo pipefail

SECRET_NAME="deepseek_music_mentor"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--inner" ]; then
	tag="$2"
	key="${!SECRET_NAME:-}"
	[ -n "$key" ] || { echo "invite: ключ пуст" >&2; exit 1; }
	printf "\$env:MM_KEY='%s'; irm https://raw.githubusercontent.com/rthw/music_mentor/%s/install.ps1 | iex" "$key" "$tag" | wl-copy
	echo "Строка установки (тег $tag) скопирована в буфер обмена. Отправь её другу и удали сообщение."
	exit 0
fi

tag="${1:-}"
if [ -z "$tag" ]; then
	tag="$(grep -m1 -oE "else \{ 'v[^']+' \}" "$ROOT/install.ps1" | grep -oE "v[^']+")"
fi
[ -n "$tag" ] || { echo "invite: не нашёл тег в install.ps1" >&2; exit 1; }
command -v wl-copy >/dev/null || { echo "invite: нужен wl-copy" >&2; exit 1; }
if ! secret list 2>/dev/null | grep -qx "$SECRET_NAME"; then
	echo "invite: в хранилище нет ключа $SECRET_NAME. Заведи отдельный ключ DeepSeek для друга и выполни: secret set $SECRET_NAME" >&2
	exit 1
fi
# Значение читает только дочерний процесс под `secret run`; на экран оно не выводится.
exec secret run "$SECRET_NAME" -- "$ROOT/tools/invite.sh" --inner "$tag"
