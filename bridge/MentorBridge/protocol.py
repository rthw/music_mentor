# -*- coding: utf-8 -*-
"""Строковый протокол MentorBridge: одна JSON-строка на входе, одна на выходе.

Основа - protocol.py из AgentBridge автора (agent_tools/win_live/remote_script/AgentBridge),
адаптирован под один код для Python 2.7 (Live 10) и 3.x (Live 11/12).
Без импортов Live, поэтому тестируется на хосте.

Запрос:  {"cmd": "имя", ...аргументы, "id": необязательный}
Ответ:   {"ok": true, "result": ...} | {"ok": false, "error": "текст"}
"""
from __future__ import unicode_literals

import json
import traceback

try:  # Python 2
    string_types = (basestring,)  # noqa: F821
    text_type = unicode  # noqa: F821
except NameError:  # Python 3
    string_types = (str,)
    text_type = str


class BridgeError(Exception):
    """Понятный отказ команды (плохой аргумент, запрет, нет объекта): уходит ученику как есть."""


def to_text(value):
    """Строка Unicode из чего угодно (в Python 2 байты считаем UTF-8)."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, text_type):
        return value
    try:
        return text_type(value)
    except Exception:  # noqa: BLE001
        shown = repr(value)
        return shown.decode("ascii", "replace") if isinstance(shown, bytes) else shown


def error_text(exc):
    if exc.args and len(exc.args) == 1:
        return to_text(exc.args[0])
    return to_text(exc)


def encode(obj):
    # ensure_ascii: ответ всегда чистый ASCII, кодировки Python 2 не мешают
    return json.dumps(obj, ensure_ascii=True, default=to_text, separators=(",", ":"))


def parse_request(line):
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    line = line.strip()
    if not line:
        raise BridgeError("Пустой запрос.")
    try:
        req = json.loads(line)
    except ValueError as exc:
        raise BridgeError("Не разобрал JSON: %s" % to_text(exc))
    if not isinstance(req, dict):
        raise BridgeError("Запрос должен быть JSON-объектом.")
    cmd = req.get("cmd")
    if not isinstance(cmd, string_types) or not cmd:
        raise BridgeError("В запросе нет поля 'cmd'.")
    return req


def dispatch(line, commands, ctx, log=None):
    """Выполнить одну строку и вернуть строку-ответ. Никогда не бросает исключений."""
    req_id = None
    try:
        req = parse_request(line)
        req_id = req.get("id")
        cmd = req["cmd"]
        handler = commands.get(cmd)
        if handler is None:
            raise BridgeError(
                "Неизвестная команда '%s'. Мост умеет: %s. Менять и удалять то, что уже есть в проекте "
                "ученика, он не умеет и не будет." % (cmd, ", ".join(sorted(k for k, v in commands.items() if not getattr(v, "forbidden", False)))))
        args = dict((k, v) for k, v in req.items() if k not in ("cmd", "id"))
        result = handler(ctx, args)
        resp = {"ok": True, "result": result}
    except BridgeError as exc:
        resp = {"ok": False, "error": error_text(exc)}
    except Exception as exc:  # noqa: BLE001 - команда не должна ронять скрипт
        if log:
            log("command failed: %s" % to_text(traceback.format_exc()))
        resp = {"ok": False, "error": "Внутренняя ошибка моста (%s): %s" % (type(exc).__name__, error_text(exc))}
    if req_id is not None:
        resp["id"] = req_id
    try:
        return encode(resp)
    except Exception as exc:  # noqa: BLE001
        return encode({"ok": False, "error": "Не удалось собрать ответ: %s" % error_text(exc)})
