# Пилот T1929: «VPS» для друга на Win7. pi работает здесь, у друга — PuTTY с обратным туннелем к Live.
FROM node:22.19.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git locales ca-certificates \
 && sed -i 's/# ru_RU.UTF-8/ru_RU.UTF-8/; s/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN npm install -g @earendil-works/pi-coding-agent@1.5.0
# fd и ripgrep pi иначе качает при первом входе ученика.
RUN apt-get update && apt-get install -y --no-install-recommends fd-find ripgrep && ln -s /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*
COPY sshd_mm.conf /etc/ssh/sshd_config.d/mm.conf
COPY mentor_login.sh /usr/local/bin/mentor_login
RUN chmod 755 /usr/local/bin/mentor_login && useradd -m -s /bin/bash drug
ENV LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
