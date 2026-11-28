#!/usr/bin/env bash
# Собрать образ и (пере)создать контейнер сервера наставника. Данные учеников живут в томах и переживают пересоздание:
#   <имя>_home — /home (рабочие папки, реестр токенов /home/.mm), <имя>_ssh — /etc/ssh (отпечаток sshd), <имя>_pkg — пакет pi.
#   tools/vps/run_container.sh [--name mm_vps] [--port 8794]
# Порт публикуется только на 127.0.0.1: наружу его выводит Caddy (tools/present/Caddyfile, /mentor/*).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name=mm_vps port=8794
while [ $# -gt 0 ]; do
	case "$1" in
		--name) name="${2:?}"; shift 2 ;;
		--port) port="${2:?}"; shift 2 ;;
		*) echo "run_container: неизвестный параметр $1" >&2; exit 1 ;;
	esac
done
docker build -q -t mm_vps "$ROOT/tools/vps" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --init --restart unless-stopped \
	-p "127.0.0.1:$port:8794" \
	-v "${name}_home:/home" -v "${name}_ssh:/etc/ssh" -v "${name}_pkg:/opt/music_mentor_pkg" \
	mm_vps >/dev/null
echo "run_container: $name запущен, http://127.0.0.1:$port/mentor/"
