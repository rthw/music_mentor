# -*- coding: utf-8 -*-
"""TCP-часть MentorBridge.

Основа - server.py из AgentBridge автора (agent_tools/win_live/remote_script/AgentBridge).

Сокет-потоки только читают строки и кладут их в очередь. Объектной моделью Live (LOM) занимается
исключительно poll(): его вызывает управляющая поверхность из update_display() в главном потоке Live.
Ответ уходит в тот же сокет.
"""
from __future__ import unicode_literals

import socket
import threading

try:
    import queue
except ImportError:  # Python 2
    import Queue as queue

REQUEST_TIMEOUT = 30.0
MAX_LINE = 1 << 20


class Pending(object):
    def __init__(self, line):
        self.line = line
        self.response = None
        self.cancelled = False
        self.done = threading.Event()


def _daemon(target, name):
    thread = threading.Thread(target=target, name=name)
    thread.daemon = True  # kwarg daemon= есть только в Python 3
    return thread


def _bytes(text):
    return text if isinstance(text, bytes) else text.encode("utf-8")


class BridgeServer(object):
    def __init__(self, host, port, log=None):
        self.host = host
        self.port = port
        self.log = log or (lambda msg: None)
        self._queue = queue.Queue()
        self._sock = None
        self._stopped = threading.Event()
        self._conns = set()
        self._lock = threading.Lock()

    def start(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((self.host, self.port))
        sock.listen(5)
        sock.settimeout(0.5)
        self._sock = sock
        self.port = sock.getsockname()[1]
        _daemon(self._accept_loop, "MentorBridge-accept").start()
        self.log("listening on %s:%d" % (self.host, self.port))

    def stop(self):
        self._stopped.set()
        with self._lock:
            conns = list(self._conns)
        for conn in conns:
            try:
                conn.close()
            except socket.error:
                pass
        if self._sock is not None:
            try:
                self._sock.close()
            except socket.error:
                pass
            self._sock = None
        self.log("stopped")

    def poll(self, handler, limit=16):
        """Только главный поток: ответить на запросы из очереди через handler(line) -> str."""
        for _ in range(limit):
            try:
                pending = self._queue.get_nowait()
            except queue.Empty:
                return
            if pending.cancelled:
                continue
            try:
                pending.response = handler(pending.line)
            except Exception as exc:  # noqa: BLE001 - handler не бросает, но сокет терять нельзя
                pending.response = '{"ok":false,"error":"internal"}'
                self.log("handler raised: %r" % (exc,))
            pending.done.set()

    def _accept_loop(self):
        while not self._stopped.is_set():
            sock = self._sock
            if sock is None:
                return
            try:
                conn, _addr = sock.accept()
            except socket.timeout:
                continue
            except (socket.error, OSError):
                return
            conn.settimeout(5.0)
            with self._lock:
                self._conns.add(conn)
            _daemon(lambda c=conn: self._serve(c), "MentorBridge-conn").start()

    def _serve(self, conn):
        buf = b""
        try:
            while not self._stopped.is_set():
                while b"\n" not in buf:
                    try:
                        chunk = conn.recv(65536)
                    except socket.timeout:
                        if self._stopped.is_set():
                            return
                        continue
                    if not chunk:
                        return
                    buf += chunk
                    if len(buf) > MAX_LINE:
                        conn.sendall(b'{"ok":false,"error":"request too long"}\n')
                        return
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                pending = Pending(line)
                self._queue.put(pending)
                if pending.done.wait(REQUEST_TIMEOUT) and pending.response is not None:
                    conn.sendall(_bytes(pending.response) + b"\n")
                else:
                    pending.cancelled = True
                    conn.sendall(b'{"ok":false,"error":"timeout: Live main thread did not answer"}\n')
        except (socket.error, OSError):
            pass
        finally:
            with self._lock:
                self._conns.discard(conn)
            try:
                conn.close()
            except (socket.error, OSError):
                pass
