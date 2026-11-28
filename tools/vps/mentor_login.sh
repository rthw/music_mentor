#!/bin/bash
# Вход друга: pi в его рабочей папке; мост Live — через обратный туннель на 127.0.0.1:9878.
export LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8 TERM="${TERM:-xterm-256color}"
# Версию pi задаёт образ (lib/win/versions.json), ученику баннер «Update Available» не нужен.
export PI_SKIP_VERSION_CHECK=1
cd "$HOME/music_mentor" || exit 1
exec pi
