# Сервер наставника для учеников на Win7 (T1929, T1938)

pi работает в контейнере, у ученика — PuTTY с обратным туннелем к его Live. Ключ DeepSeek остаётся на сервере.

```bash
docker build -t mm_vps tools/vps
docker run -d --name mm_vps_pilot -p 2222:22 mm_vps          # адрес и порт, куда достучится ученик
tools/vps/new_learner.sh ivan --host <адрес> --port 2222     # -> ~/.cache/music_mentor/bundles/ivan.zip
```

Нужно один раз: `~/.cache/music_mentor/win7_assets/` с `putty.exe` (PuTTY 0.85 x64) и `vc_redist.x64.exe`
(14.44), суммы — `win7/assets.sha256`; ключ в `secret` под именем `deepseek_music_mentor`.

`new_learner.sh` создаёт пользователя (группа `mentors`), рабочую папку из `template/`, пакет (`pi install`),
`settings.json`/`auth.json`, пару ключей ed25519 (в `authorized_keys` — с `permitlisten` только на свой порт
туннеля 9901, 9902, …; приватный — только в `.ppk` внутри zip) и собирает zip. Повтор для того же имени —
новый ключ. Ученика, которого нужно отключить: `docker exec <c> userdel -r <имя>`.

Хостовые ключи sshd живут в контейнере: пересоздали контейнер — отпечаток сменится, и все `-hostkey` в
выданных лаунчерах перестанут подходить (монтируйте `/etc/ssh` томом, если контейнер будут пересоздавать).
