# -*- coding: utf-8 -*-
"""Мост «со стороны ученика» для сквозного теста (tests/win7_installer.test.ts): fake_lom + BridgeServer + RemoteLink.

Читает mentor_remote.json из папки, переданной аргументом (как распакованный zip ученика), печатает READY и живёт,
пока его не остановят. Один код для Python 2.7 и 3.
"""
from __future__ import unicode_literals, print_function

import os
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "bridge"))
_cs = types.ModuleType(str("_Framework.ControlSurface"))
_cs.ControlSurface = type(str("ControlSurface"), (object,), {})
sys.modules.setdefault(str("_Framework"), types.ModuleType(str("_Framework")))
sys.modules.setdefault(str("_Framework.ControlSurface"), _cs)

from MentorBridge import commands, protocol, remote, server  # noqa: E402
import fake_lom  # noqa: E402

ctx = fake_lom.make_ctx("legacy")
fake_lom.learner_project(ctx)
srv = server.BridgeServer("127.0.0.1", 0, lambda m: sys.stderr.write(m + "\n"))
srv.start()
cfg = remote.find_config(os.path.abspath(sys.argv[1]))
link = remote.RemoteLink(cfg, srv, lambda m: sys.stderr.write(m + "\n"))
link.start()
print("READY")
sys.stdout.flush()
while True:  # главный поток = «поток Live»: только он трогает LOM
    srv.poll(lambda line: protocol.dispatch(line, commands.COMMANDS, ctx))
    time.sleep(0.01)
