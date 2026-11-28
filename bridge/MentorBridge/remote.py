# -*- coding: utf-8 -*-
"""HTTPS-транспорт моста (T1940): Win7 не выпустить TCP наружу, зато Python Live 10 умеет HTTPS.

Если рядом с мостом лежит mentor_remote.json {"url": "https://host/mentor", "token": "..."}, фоновый поток
long-poll'ит GET <url>/b/<token>/next, кладёт запрос в ту же очередь, что и TCP-запросы (LOM трогает только poll()
главного потока Live), и отправляет ответ POST <url>/b/<token>/result {id, line}. Проверка сертификата включена.
Сеть пропала - повтор с растущей паузой до 30 с; ошибки уходят в лог (без токена). Live не тормозит:
всё сетевое - в фоновых потоках.

Один код для Python 2.7 и 3.
"""
from __future__ import unicode_literals

import io
import json
import os
import socket
import ssl
import threading

try:  # Python 3
    from http.client import HTTPSConnection, HTTPConnection
    from urllib.parse import urlsplit
except ImportError:  # Python 2
    from httplib import HTTPSConnection, HTTPConnection
    from urlparse import urlsplit

CONFIG_NAME = "mentor_remote.json"
POLL_TIMEOUT = 40.0  # дольше, чем long-poll сервера (~25 с)
MAX_BACKOFF = 30.0
MAX_IN_FLIGHT = 8


def find_config(start_dir):
    """mentor_remote.json лежит в папке моста или на уровень выше. Вернёт dict или None."""
    for folder in (start_dir, os.path.dirname(start_dir)):
        path = os.path.join(folder, CONFIG_NAME)
        if os.path.isfile(path):
            with io.open(path, encoding="utf-8-sig") as fh:
                cfg = json.load(fh)
            if not isinstance(cfg, dict) or not cfg.get("url") or not cfg.get("token"):
                raise ValueError("%s: нужны поля url и token" % CONFIG_NAME)
            return cfg
    return None


def _context(cafile=None):
    """Контекст TLS с проверкой сертификата и имени хоста (в Python 2.7.9+ и 3.4+ это умолчание)."""
    try:
        ctx = ssl.create_default_context(cafile=cafile)
    except AttributeError:  # Python < 2.7.9: проверки нет, поэтому не подключаемся вовсе
        raise RuntimeError("Python Live слишком старый для проверки сертификата")
    return ctx


class RemoteLink(object):
    def __init__(self, config, server, log=None, cafile=None, wait=None):
        parts = urlsplit(config["url"].rstrip("/"))
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise ValueError("url: нужен адрес вида https://хост/mentor")
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port
        self.prefix = parts.path
        self.token = config["token"]
        self.server = server
        self.log = log or (lambda msg: None)
        self._cafile = cafile
        self._ctx = _context(cafile) if self.scheme == "https" else None
        self._stopped = threading.Event()
        self._slots = threading.Semaphore(MAX_IN_FLIGHT)
        self._wait = wait or self._stopped.wait  # пауза между повторами; в тестах подменяется
        self.connected = False

    # --- HTTP ------------------------------------------------------------------------------------------------
    def _conn(self, timeout):
        if self.scheme == "https":
            return HTTPSConnection(self.host, self.port, timeout=timeout, context=self._ctx)
        return HTTPConnection(self.host, self.port, timeout=timeout)

    def _request(self, method, tail, body=None, timeout=POLL_TIMEOUT):
        conn = self._conn(timeout)
        try:
            # str(): в Python 2 unicode в адресе и заголовках вместе с байтовым телом ломает сборку запроса
            headers = {str("Accept"): str("application/json"), str("Connection"): str("close")}
            if body is not None:
                headers[str("Content-Type")] = str("application/json")
                headers[str("Content-Length")] = str(len(body))
            conn.request(str(method), str("%s/b/%s/%s" % (self.prefix, self.token, tail)), body, headers)
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, data
        finally:
            conn.close()

    def _safe(self, exc):
        text = "%s: %s" % (exc.__class__.__name__, exc)
        return text.replace(self.token, "<token>")

    # --- потоки ----------------------------------------------------------------------------------------------
    def start(self):
        t = threading.Thread(target=self._poll_loop, name="MentorBridge-remote")
        t.daemon = True
        t.start()
        self.log("remote: %s://%s%s" % (self.scheme, self.host, self.prefix))

    def stop(self):
        self._stopped.set()

    def _poll_loop(self):
        delay = 1.0
        while not self._stopped.is_set():
            try:
                status, data = self._request("GET", "next")
            except (socket.error, ssl.SSLError, ValueError, OSError, Exception) as exc:  # noqa: BLE001 - поток не должен умирать
                if self.connected:
                    self.log("remote: связь потеряна: %s" % self._safe(exc))
                self.connected = False
                self._wait(delay)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            if status == 204:
                self._mark_up()
                delay = 1.0
                continue
            if status != 200:
                self.log("remote: next -> HTTP %s" % status)
                self.connected = False
                self._wait(delay)
                delay = min(delay * 2, MAX_BACKOFF)
                continue
            self._mark_up()
            delay = 1.0
            try:
                msg = json.loads(data.decode("utf-8"))
                req_id, line = msg["id"], msg["line"]
            except Exception as exc:  # noqa: BLE001
                self.log("remote: плохой ответ next: %s" % self._safe(exc))
                continue
            self._slots.acquire()
            t = threading.Thread(target=self._answer, args=(req_id, line), name="MentorBridge-remote-req")
            t.daemon = True
            t.start()

    def _mark_up(self):
        if not self.connected:
            self.connected = True
            self.log("remote: на связи")

    def _answer(self, req_id, line):
        try:
            if not isinstance(line, bytes):
                line = line.encode("utf-8")
            pending = self.server.submit(line)
            if pending.done.wait(self.server_timeout()) and pending.response is not None:
                out = pending.response
            else:
                pending.cancelled = True
                out = '{"ok":false,"error":"timeout: Live main thread did not answer"}'
            if isinstance(out, bytes):
                out = out.decode("utf-8")
            body = json.dumps({"id": req_id, "line": out}).encode("utf-8")
            for attempt in range(3):
                try:
                    status, _ = self._request("POST", "result", body, timeout=20.0)
                    if status == 200 or status == 404:  # 404 - сервер уже отказал pi по таймауту
                        return
                    self.log("remote: result -> HTTP %s" % status)
                except Exception as exc:  # noqa: BLE001
                    self.log("remote: result не ушёл: %s" % self._safe(exc))
                if self._stopped.is_set():
                    return
                self._wait(1.0 + attempt)
        finally:
            self._slots.release()

    def server_timeout(self):
        return getattr(self.server, "request_timeout", 30.0)
