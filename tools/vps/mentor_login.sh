#!/bin/bash
# Вход ученика: pi в его рабочей папке; мост Live — через обратный туннель на 127.0.0.1:<его порт>.
export LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8 TERM="${TERM:-xterm-256color}"
# Версию pi задаёт образ (lib/win/versions.json), ученику баннер «Update Available» не нужен.
export PI_SKIP_VERSION_CHECK=1
# У каждого ученика свой порт туннеля (new_learner.sh кладёт его в ~/.mm_bridge_port и в
# authorized_keys как permitlisten): иначе двое одновременно делили бы 9878 и pi одного читал бы Live другого.
if [ -r "$HOME/.mm_bridge_port" ]; then MM_LIVE_PORT="$(tr -dc '0-9' < "$HOME/.mm_bridge_port")"; export MM_LIVE_PORT; fi
cd "$HOME/music_mentor" || exit 1
exec pi
