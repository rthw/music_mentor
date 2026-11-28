# Сервер наставника (T1929 пилот, T1938 много учеников, T1940 HTTPS): pi работает здесь, у ученика на Win7 — браузер
# (веб-терминал ttyd) и мост в Live, который ходит к ретранслятору по HTTPS через present.whimsical.work.
# Учеников заводит tools/vps/new_learner.sh (пользователь, токен, настройки pi). Запуск: tools/vps/run_container.sh.
FROM node:22.19.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git locales ca-certificates curl util-linux \
 && sed -i 's/# ru_RU.UTF-8/ru_RU.UTF-8/; s/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN npm install -g @earendil-works/pi-coding-agent@1.5.0
# fd и ripgrep pi иначе качает при первом входе ученика.
RUN apt-get update && apt-get install -y --no-install-recommends fd-find ripgrep && ln -s /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*
# ttyd 1.7.7: в Debian bookworm пакета нет; статический бинарь с проверкой суммы.
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
RUN curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
 && echo "$TTYD_SHA256  /usr/local/bin/ttyd" | sha256sum -c - && chmod 755 /usr/local/bin/ttyd
COPY relay/mm_relay.mjs /usr/local/lib/mm_relay.mjs
COPY mentor_web.sh /usr/local/bin/mentor_web
COPY entrypoint.sh /usr/local/bin/mm_entrypoint
# /etc/ssh — том (отпечаток sshd переживает пересоздание), поэтому конфиг кладёт entrypoint, а не образ.
COPY sshd_mm.conf /usr/local/share/mm_sshd.conf
COPY mentor_login.sh /usr/local/bin/mentor_login
# Все ученики — в группе mentors: sshd пускает только её (sshd_mm.conf).
RUN chmod 755 /usr/local/bin/mentor_login /usr/local/bin/mentor_web /usr/local/bin/mm_entrypoint && groupadd mentors
ENV LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8
# 22 — sshd (администрирование), 8794 — ретранслятор и веб-терминал (на хосте только 127.0.0.1, дальше Caddy).
EXPOSE 22 8794
CMD ["/usr/local/bin/mm_entrypoint"]
