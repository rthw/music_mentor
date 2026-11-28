# Сервер наставника для учеников на Win7 (T1929, T1938, T1940)

pi работает в контейнере; ученик открывает его в браузере (веб-терминал ttyd), а мост в его Live ходит к серверу по HTTPS.
Всё идёт через `https://present.whimsical.work/mentor/…` (Cloudflare Tunnel → Caddy → контейнер): наружу ни одного TCP-порта.
Ключ DeepSeek остаётся на сервере. Подробности — `docs/spec.md`, §7c.

```bash
tools/vps/run_container.sh                       # образ mm_vps + контейнер mm_vps (тома, --restart unless-stopped, 127.0.0.1:8794)
tools/vps/new_learner.sh ivan                    # -> ~/.cache/music_mentor/bundles/ivan.zip (адрес — https://present.whimsical.work/mentor)
```

Нужно один раз: `~/.cache/music_mentor/win7_assets/vc_redist.x64.exe` (14.44, сумма — `win7/assets.sha256`);
ключ в `secret` под именем `deepseek_music_mentor`; `present_site.service` с `handle /mentor/*` в `tools/present/Caddyfile`
(после правки Caddyfile: `systemctl --user restart present_site`).

Состав:

- `relay/mm_relay.mjs` — ретранслятор (Node без зависимостей): слушает порт каждого ученика для pi, отдаёт мосту запросы по `GET /mentor/b/<token>/next`,
  принимает ответы `POST …/result`, проксирует `/mentor/t/<token>/` в ttyd ученика. Реестр — `/home/.mm/learners/<имя>.json` (хеш токена).
- `mentor_web.sh` — что запускает ttyd (`runuser -l <имя> -c mentor_login`); `mentor_login.sh` — pi в рабочей папке ученика, `MM_LIVE_PORT`, `MM_REMOTE_FILES=1`.
- `entrypoint.sh` — sshd (администрирование) + ретранслятор; возвращает в контейнер учеников из реестра после пересоздания.

`new_learner.sh` создаёт пользователя (группа `mentors`), рабочую папку из `template/`, пакет (`pi install`), `settings.json`/`auth.json`, свой порт моста
(9901, 9902, …), токен (32 случайных байта; на сервере только sha256) и собирает zip: `MentorBridge/`, `mentor_remote.json`, `mentor_url.txt`,
`install_win7.cmd`, `win7_shortcut.ps1`, `vc_redist.x64.exe`, `README.txt`. Повтор для того же имени — новый токен (старый, в том числе ярлык и мост
из прежнего zip, перестаёт работать). Отключить ученика: `docker exec mm_vps sh -c 'userdel -r <имя>; rm /home/.mm/learners/<имя>.json'`.

Тома `mm_vps_home`, `mm_vps_ssh`, `mm_vps_pkg` переживают пересоздание контейнера (`run_container.sh`): рабочие папки, токены и отпечаток sshd остаются.
Старый пилотный контейнер `mm_vps_pilot` (PuTTY, порт 2222) этой схемой не используется и может быть удалён.
Проверка: `npm test` (в т. ч. сквозной тест `tests/win7_installer.test.ts` — временный контейнер, `new_learner.sh`, мост из `tests/bridge/` по HTTP,
`live` ping через порт ученика), `python3 tests/bridge/test_mentor_bridge.py`.
