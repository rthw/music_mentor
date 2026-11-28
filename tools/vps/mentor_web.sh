#!/bin/bash
# Веб-терминал ученика (ttyd зовёт это на каждую вкладку): pi под его пользователем, как после входа по ssh.
user="${1:?имя ученика}"
[[ "$user" =~ ^[a-z][a-z0-9_]{1,30}$ ]] || { echo "плохое имя"; exit 1; }
id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx mentors || { echo "нет такого ученика"; exit 1; }
exec runuser -l "$user" -c 'exec /usr/local/bin/mentor_login'
