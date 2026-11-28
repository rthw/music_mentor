#!/bin/bash
# Вход друга: pi в его рабочей папке; мост Live — через обратный туннель на 127.0.0.1:9878.
export LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8 TERM="${TERM:-xterm-256color}"
cd "$HOME/music_mentor" || exit 1
exec pi
