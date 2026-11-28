#!/bin/sh
# Контейнер наставника: sshd (администрирование) + ретранслятор HTTPS-моста и веб-терминала.
set -e
mkdir -p /run/sshd /run/mm /home/.mm/learners
chmod 700 /run/mm /home/.mm
mkdir -p /etc/ssh/sshd_config.d
cp /usr/local/share/mm_sshd.conf /etc/ssh/sshd_config.d/mm.conf
ssh-keygen -A >/dev/null
/usr/sbin/sshd -e
exec node /usr/local/lib/mm_relay.mjs
