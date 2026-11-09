# -*- coding: utf-8 -*-
"""MentorBridge: Remote Script для Ableton Live, отдаёт модель Live (LOM) строками JSON по TCP 127.0.0.1:9878.

Основа - AgentBridge автора (agent_tools/win_live/remote_script/AgentBridge), порт 9878 вместо 9877,
чтобы оба скрипта работали вместе. Один код для Python 2.7 (Live 10) и 3.x (Live 11/12).
Только читает и добавляет: изменять и удалять существующее в проекте ученика мост не умеет.

Включить один раз: Preferences > Link/Tempo/MIDI (Live 10: MIDI Sync) > Control Surface > MentorBridge,
Input и Output - None.
"""
from __future__ import unicode_literals

import io
import os
import time

try:
    from _Framework.ControlSurface import ControlSurface
except ImportError:  # pragma: no cover - новые раскладки Live
    from ableton.v2.control_surface import ControlSurface

HOST = "127.0.0.1"
PORT = 9878
LOG_PATH = os.path.join(os.path.expanduser("~"), "Documents", "Ableton", "MentorBridge.log")
LOG_MAX = 1 << 20


def _log(message):
    try:
        if not isinstance(message, type("")):
            message = message.decode("utf-8", "replace")
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX:
            old = LOG_PATH + ".1"
            if os.path.exists(old):
                os.remove(old)
            os.rename(LOG_PATH, old)  # rename: в Python 2.7 нет замены файла одним вызовом
        with io.open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), message))
    except Exception:  # noqa: BLE001 - лог не должен ломать Live
        pass


def create_instance(c_instance):
    return MentorBridge(c_instance)


class _Ctx(object):
    def __init__(self, surface):
        import Live
        self.live = Live
        self.song = surface.song()
        self.application = surface.application()
        self.log = _log


class MentorBridge(ControlSurface):
    def __init__(self, c_instance):
        super(MentorBridge, self).__init__(c_instance)
        self._server = None
        self._ctx = None
        try:
            from .commands import COMMANDS
            from .protocol import dispatch
            from .server import BridgeServer
            self._commands = COMMANDS
            self._dispatch = dispatch
            self._ctx = _Ctx(self)
            self._server = BridgeServer(HOST, PORT, _log)
            self._server.start()
            self.show_message("MentorBridge: listening on %s:%d" % (HOST, PORT))
            _log("started")
        except Exception as exc:  # noqa: BLE001
            import traceback
            _log("start failed: %s" % traceback.format_exc())
            self.show_message("MentorBridge failed: %s" % exc)

    def _handle(self, line):
        return self._dispatch(line, self._commands, self._ctx, _log)

    def update_display(self):
        super(MentorBridge, self).update_display()
        if self._server is not None:
            self._server.poll(self._handle)

    def disconnect(self):
        _log("disconnect")
        if self._server is not None:
            self._server.stop()
            self._server = None
        super(MentorBridge, self).disconnect()
