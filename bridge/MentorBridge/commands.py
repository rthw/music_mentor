# -*- coding: utf-8 -*-
"""Команды MentorBridge поверх объектной модели Live (LOM).

Основа - commands.py из AgentBridge автора (agent_tools/win_live/remote_script/AgentBridge).
Обработчик: handler(ctx, args) -> JSON-совместимый результат. ctx даёт song, application, live
(модуль Live, нужен для нот) и log. Live здесь не импортируется: тесты подставляют фейки.
Обработчики работают только в главном потоке Live (см. server.BridgeServer.poll).

Главное правило (решение автора 2026-11-08): мост только ЧИТАЕТ и ДОБАВЛЯЕТ.
  - свои треки называются «Подсказка: …» и красятся фиксированным цветом - это "треки-подсказки";
  - клип можно положить только в ПУСТОЙ слот трека-подсказки или MIDI-трека ученика;
  - устройства и параметры - только на треках-подсказках;
  - удалять можно только трек-подсказку и только с confirmed=true;
  - всё остальное (правка клипа, ноты, устройства и параметры ученика, микшер, темп) - отказ ok:false.
Запрет живёт здесь, в коде, а не в промпте.

Один код для Python 2.7 и 3.x: без f-строк и аннотаций.
"""
from __future__ import unicode_literals

import re
import sys

from .protocol import BridgeError, string_types, text_type, to_text

BRIDGE_VERSION = 1
PREFIX = "Подсказка: "
HINT_COLOR = 0x2E9BFF  # фиксированный цвет треков и клипов-подсказок
MAX_CLIP_BEATS = 512.0
MAX_NOTES = 4000
BROWSER_LIMIT = 200
# Все добавления в Live - в главном потоке; в Live 10 нет arrangement_clips, шимы - по hasattr.

PY2 = sys.version_info[0] == 2


# ---------------------------------------------------------------- вспомогательное

def _text(value):
    """Имя из LOM как Unicode (в Live 10 / Python 2 может прийти str в UTF-8)."""
    return to_text(value)


def _native(value):
    return value.encode("utf-8") if PY2 and isinstance(value, text_type) else value


def _set_name(obj, name):
    """Записать имя; в Python 2 если Unicode не принят - байты UTF-8."""
    try:
        obj.name = name
    except Exception:  # noqa: BLE001
        obj.name = _native(name)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return default


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool) or (PY2 and isinstance(value, long))  # noqa: F821


def _num(args, key, minimum=0):
    if key not in args:
        raise BridgeError("Не хватает поля '%s'." % key)
    value = args[key]
    if not _is_int(value) or value < minimum:
        raise BridgeError("Поле '%s' должно быть целым числом >= %d, а пришло %r." % (key, minimum, value))
    return value


def _is_hint(track):
    return _text(track.name).startswith(PREFIX)


def _resolve_track(ctx, ref):
    """Трек по номеру (с 0) или точному имени -> (индекс, трек)."""
    tracks = list(ctx.song.tracks)
    if isinstance(ref, string_types):
        found = [i for i, t in enumerate(tracks) if _text(t.name) == ref]
        if not found:
            names = ", ".join("«%s»" % _text(t.name) for t in tracks) or "нет"
            raise BridgeError("Трека «%s» нет. Есть: %s." % (ref, names))
        if len(found) > 1:
            raise BridgeError("Имя «%s» не уникально (треки %s): назови трек номером." % (
                ref, ", ".join(str(i) for i in found)))
        return found[0], tracks[found[0]]
    if not _is_int(ref) or ref < 0:
        raise BridgeError("Трек - это номер (с 0) или имя, а пришло %r." % (ref,))
    if ref >= len(tracks):
        raise BridgeError("Трека %d нет: в проекте %d треков." % (ref, len(tracks)))
    return ref, tracks[ref]


def _track_arg(ctx, args, key="track"):
    if key not in args:
        raise BridgeError("Не хватает поля '%s'." % key)
    return _resolve_track(ctx, args[key])


def _refuse_learner_track(track, what):
    raise BridgeError(
        "Это трек ученика «%s»: %s. Мост ничего не меняет в проекте ученика - только добавляет свои "
        "треки «%s…» и клипы в пустые слоты. Предложи вариант на новом треке-подсказке." % (
            _text(track.name), what, PREFIX))


def _need_hint(track, what):
    if not _is_hint(track):
        _refuse_learner_track(track, what)


def _slot(track, args):
    slot_index = _num(args, "slot")
    slots = list(track.clip_slots)
    if slot_index >= len(slots):
        raise BridgeError("Слота %d нет: на треке «%s» их %d. Новые сцены мост не добавляет." % (
            slot_index, _text(track.name), len(slots)))
    return slot_index, slots[slot_index]


def _first_empty_slot(track):
    for i, slot in enumerate(track.clip_slots):
        if not slot.has_clip:
            return i
    return None


def _device(track, ref):
    devices = list(track.devices)
    if _is_int(ref):
        if 0 <= ref < len(devices):
            return devices[ref]
        raise BridgeError("Устройства %d нет: на треке их %d." % (ref, len(devices)))
    if isinstance(ref, string_types):
        low = ref.lower()
        for dev in devices:
            if _text(dev.name).lower() == low or _text(dev.class_name).lower() == low:
                return dev
        names = ", ".join("%s/%s" % (_text(d.name), _text(d.class_name)) for d in devices) or "нет"
        raise BridgeError("Устройства «%s» на треке нет (есть: %s)." % (ref, names))
    raise BridgeError("Поле 'device' - номер или имя устройства.")


# ---------------------------------------------------------------- ноты (шимы Live 10 и 11+)

def _clip_span(clip):
    span = max(float(clip.length), 0.001)
    for name in ("end_marker", "loop_end"):
        value = getattr(clip, name, None)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            span = max(span, float(value))
    return span


def read_notes(clip):
    """get_notes_extended (11+) или get_notes (10; аргументы там в другом порядке)."""
    span = _clip_span(clip)
    if hasattr(clip, "get_notes_extended"):
        raw = clip.get_notes_extended(0, 128, 0.0, span)
        notes = [{"pitch": n.pitch, "start": n.start_time, "duration": n.duration,
                  "velocity": n.velocity} for n in raw]
    else:
        raw = clip.get_notes(0.0, 0, span, 128)  # from_time, from_pitch, time_span, pitch_span
        notes = [{"pitch": n[0], "start": n[1], "duration": n[2], "velocity": n[3]} for n in raw]
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


def add_notes(ctx, clip, notes):
    """add_new_notes (11+) или set_notes (10). Только в только что созданный пустой клип."""
    if not notes:
        return
    if hasattr(clip, "add_new_notes"):
        specs = [ctx.live.Clip.MidiNoteSpecification(
            pitch=n["pitch"], start_time=n["start"], duration=n["duration"], velocity=n["velocity"], mute=False)
            for n in notes]
        clip.add_new_notes(tuple(specs))
    else:
        clip.set_notes(tuple((n["pitch"], n["start"], n["duration"], n["velocity"], False) for n in notes))


def _parse_notes(args, length):
    notes = args.get("notes") or []
    if not isinstance(notes, list):
        raise BridgeError("Поле 'notes' - список нот.")
    if len(notes) > MAX_NOTES:
        raise BridgeError("Слишком много нот в одном клипе: %d (максимум %d)." % (len(notes), MAX_NOTES))
    out = []
    for i, note in enumerate(notes):
        try:
            pitch, start = int(note["pitch"]), float(note["start"])
            duration, velocity = float(note["duration"]), float(note.get("velocity", 100))
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise BridgeError("Нота %d: нужны pitch, start, duration[, velocity] (%s)." % (i, to_text(exc)))
        if not 0 <= pitch <= 127 or duration <= 0 or start < 0 or not 1 <= velocity <= 127:
            raise BridgeError("Нота %d вне допустимых границ: %r." % (i, note))
        if start >= length:
            raise BridgeError("Нота %d начинается в %g, а клип длиной %g долей." % (i, start, length))
        out.append({"pitch": pitch, "start": start, "duration": duration, "velocity": int(round(velocity))})
    return out


# ---------------------------------------------------------------- чтение

def _version(ctx):
    app = ctx.application
    parts = []
    for name in ("get_major_version", "get_minor_version", "get_bugfix_version"):
        fn = getattr(app, name, None)
        parts.append(_safe(fn, None) if fn else None)
    return ".".join(str(p) for p in parts if p is not None) or None


def cmd_ping(ctx, args):
    return {"pong": True, "bridge": "MentorBridge", "version": BRIDGE_VERSION, "live": _version(ctx),
            "python": "%d.%d.%d" % sys.version_info[:3], "hint_prefix": PREFIX}


def _track_index(ctx, track):
    tracks = list(ctx.song.tracks)
    return tracks.index(track) if track in tracks else None


def cmd_song(ctx, args):
    song = ctx.song
    view = song.view
    scene = _safe(lambda: list(song.scenes).index(view.selected_scene))
    clip = _safe(lambda: view.detail_clip)
    out = {
        "tempo": song.tempo,
        "signature": [song.signature_numerator, song.signature_denominator],
        "is_playing": bool(song.is_playing),
        "track_count": len(list(song.tracks)),
        "scene_count": len(list(song.scenes)),
        "selected_track": _track_index(ctx, view.selected_track),
        "selected_scene": scene,
        "selected_clip": _text(clip.name) if clip is not None else None,
    }
    path = _safe(lambda: _text(song.file_path))  # есть не во всех версиях Live
    if path:
        out["file_path"] = path
    if hasattr(song, "scale_name"):  # Live 12
        out["scale"] = {"root_note": _safe(lambda: song.root_note), "name": _safe(lambda: _text(song.scale_name)),
                        "mode": _safe(lambda: bool(song.scale_mode))}
    return out


def _clip_info(clip, slot_index=None):
    out = {"name": _text(clip.name), "length": clip.length, "is_midi_clip": bool(clip.is_midi_clip),
           "is_playing": bool(clip.is_playing)}
    if slot_index is not None:
        out["slot"] = slot_index
    if clip.is_midi_clip:
        out["note_count"] = len(read_notes(clip))
    return out


def cmd_tracks(ctx, args):
    out = []
    for i, track in enumerate(ctx.song.tracks):
        item = {
            "index": i, "name": _text(track.name), "type": "midi" if track.has_midi_input else "audio",
            "hint": _is_hint(track),
            "devices": [{"name": _text(d.name), "class_name": _text(d.class_name)} for d in track.devices],
            "slot_count": len(list(track.clip_slots)),
            "clips": [_clip_info(s.clip, k) for k, s in enumerate(track.clip_slots) if s.has_clip],
        }
        if hasattr(track, "arrangement_clips"):  # в Live 10 нет: Arrangement читается из .als
            item["arrangement_clips"] = [
                {"name": _text(c.name), "start": float(c.start_time), "length": float(c.length)}
                for c in track.arrangement_clips]
        out.append(item)
    return {"tracks": out}


def cmd_clip_notes(ctx, args):
    index, track = _track_arg(ctx, args)
    slot_index, slot = _slot(track, args)
    if not slot.has_clip:
        return {"exists": False, "track": index, "slot": slot_index}
    clip = slot.clip
    if not clip.is_midi_clip:
        raise BridgeError("В слоте %d аудиоклип «%s»: у него нет нот." % (slot_index, _text(clip.name)))
    return {"exists": True, "track": index, "slot": slot_index, "name": _text(clip.name), "length": clip.length,
            "loop_start": float(getattr(clip, "loop_start", 0.0)), "notes": read_notes(clip)}


def _norm(name):
    return re.sub(r"\.[A-Za-z0-9]{2,4}$", "", name).strip().lower()


BROWSER_ROOTS = ("instruments", "midi_effects", "audio_effects", "drums", "sounds", "user_library", "packs",
                 "samples", "clips", "plugins", "max_for_live")


def _browser_item(browser, path):
    parts = [p for p in path.strip("/").split("/") if p]
    if not parts:
        raise BridgeError("Пустой путь в браузере.")
    root_name = parts[0].lower()
    root = getattr(browser, root_name, None) if root_name in BROWSER_ROOTS else None
    if root is None:
        have = [r for r in BROWSER_ROOTS if hasattr(browser, r)]
        raise BridgeError("Раздела браузера '%s' нет. Есть: %s." % (parts[0], ", ".join(have)))
    item, walked = root, [parts[0]]
    for part in parts[1:]:
        children = list(item.children)
        match = next((c for c in children if _text(c.name) == part), None)
        if match is None:
            match = next((c for c in children if _text(c.name).lower() == part.lower()), None)
        if match is None:
            match = next((c for c in children if _norm(_text(c.name)) == _norm(part)), None)
        if match is None:
            names = ", ".join(_text(c.name) for c in children[:40])
            raise BridgeError("'%s' нет в %s (там: %s)." % (part, "/".join(walked), names))
        item = match
        walked.append(part)
    return item


def cmd_browser(ctx, args):
    """Что есть в браузере Live ученика (то есть в его редакции). Без path - разделы."""
    browser = ctx.application.browser
    path = args.get("path")
    if not path:
        return {"roots": [r for r in BROWSER_ROOTS if hasattr(browser, r)]}
    if not isinstance(path, string_types):
        raise BridgeError("Поле 'path' - строка вида 'instruments/Wavetable'.")
    item = _browser_item(browser, path)
    limit = args.get("limit", BROWSER_LIMIT)
    limit = limit if _is_int(limit) and limit > 0 else BROWSER_LIMIT
    children = list(item.children)
    return {"path": path, "name": _text(item.name), "loadable": bool(item.is_loadable), "total": len(children),
            "children": [{"name": _text(c.name), "loadable": bool(c.is_loadable)} for c in children[:limit]]}


# ---------------------------------------------------------------- запись (только добавление)

def _paint(obj):
    try:
        obj.color = HINT_COLOR
    except Exception:  # noqa: BLE001 - цвета в старых Live может не быть; не критично
        pass


def _edition_limit_error(count, why):
    return BridgeError(
        "Live не дал добавить трек (сейчас их %d). Скорее всего, в твоей редакции число треков ограничено "
        "(в Lite - 8, в Intro - 16). Освободи место сам или работай без нового трека: положи вариант в "
        "пустой слот на своём MIDI-треке. Подробности Live: %s" % (count, why))


def cmd_add_midi_track(ctx, args):
    raw = args.get("name", "")
    if not isinstance(raw, string_types):
        raise BridgeError("Поле 'name' - строка.")
    name = raw.strip()
    if name.startswith(PREFIX):
        name = name[len(PREFIX):]
    full = PREFIX + (name or "идея")
    before = len(list(ctx.song.tracks))
    try:
        ctx.song.create_midi_track(-1)
    except Exception as exc:  # noqa: BLE001
        raise _edition_limit_error(before, to_text(exc))
    after = list(ctx.song.tracks)
    if len(after) != before + 1:
        raise _edition_limit_error(before, "число треков не изменилось")
    track = after[-1]
    try:
        _set_name(track, full)
        if _text(track.name) != full:
            raise RuntimeError("имя не записалось")
    except Exception as exc:  # noqa: BLE001
        ctx.song.delete_track(len(after) - 1)  # откат своего же трека
        raise BridgeError("Трек создался, но имя «%s» не записалось (%s); трек убрал." % (full, to_text(exc)))
    _paint(track)
    return {"index": len(after) - 1, "name": _text(track.name)}


def cmd_add_clip(ctx, args):
    index, track = _track_arg(ctx, args)
    if not track.has_midi_input:
        raise BridgeError("На треке «%s» аудио, а клип с нотами можно положить только на MIDI-трек." % _text(track.name))
    slot_index, slot = _slot(track, args)
    if slot.has_clip:
        free = _first_empty_slot(track)
        raise BridgeError(
            "Слот %d на треке «%s» занят клипом «%s». Существующие клипы мост не меняет и не заменяет. %s" % (
                slot_index, _text(track.name), _text(slot.clip.name),
                "Первый пустой слот: %d." % free if free is not None else
                "Пустых слотов на этом треке нет - используй новый трек-подсказку."))
    length = args.get("length_beats")
    if isinstance(length, bool) or not isinstance(length, (int, float)) or not 0 < length <= MAX_CLIP_BEATS:
        raise BridgeError("'length_beats' - число долей больше 0 и не больше %d." % MAX_CLIP_BEATS)
    length = float(length)
    notes = _parse_notes(args, length)  # проверяем до создания: при ошибке ничего не остаётся
    raw = args.get("name", "")
    if not isinstance(raw, string_types):
        raise BridgeError("Поле 'name' - строка.")
    name = raw.strip()
    if name.startswith(PREFIX):
        name = name[len(PREFIX):]
    full = PREFIX + (name or "вариант")
    slot.create_clip(length)
    clip = slot.clip
    try:
        _set_name(clip, full)
        add_notes(ctx, clip, notes)
    except Exception as exc:  # noqa: BLE001
        slot.delete_clip()  # откат своего же только что созданного клипа
        raise BridgeError("Клип не удалось заполнить (%s); пустой слот восстановил." % to_text(exc))
    _paint(clip)
    return {"track": index, "slot": slot_index, "name": _text(clip.name), "length": clip.length,
            "note_count": len(read_notes(clip))}


def cmd_load_device(ctx, args):
    index, track = _track_arg(ctx, args)
    _need_hint(track, "загружать на него устройства нельзя")
    path = args.get("path")
    if not isinstance(path, string_types) or not path:
        raise BridgeError("Не хватает поля 'path' (например 'instruments/Wavetable'; что есть - команда browser).")
    browser = ctx.application.browser
    item = _browser_item(browser, path)
    if not item.is_loadable:
        names = ", ".join(_text(c.name) for c in list(item.children)[:20])
        raise BridgeError("'%s' - папка, её нельзя загрузить (внутри: %s)." % (path, names))
    view = ctx.song.view
    previous = view.selected_track
    view.selected_track = track
    try:
        if view.selected_track != track:
            raise BridgeError("Не удалось выбрать трек-подсказку, устройство не загружаю.")
        before = len(list(track.devices))
        browser.load_item(item)
        devices = [_text(d.name) for d in track.devices]
    finally:
        if previous is not None:
            _safe(lambda: setattr(view, "selected_track", previous))
    if len(devices) <= before:
        raise BridgeError("Live не загрузил '%s' (возможно, его нет в твоей редакции)." % path)
    return {"track": index, "loaded": _text(item.name), "devices": devices}


PARAM_ALIASES = {
    "MidiArpeggiator": {"rate": "Synced Rate", "distance": "Transp. Dist.", "steps": "Transp. Steps",
                        "hold": "Hold On"},
}
_NUM_RE = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _display(param, value=None):
    value = param.value if value is None else value
    try:
        return _text(param.str_for_value(value))
    except Exception:  # noqa: BLE001
        return to_text(value)


def _find_param(dev, name):
    if not isinstance(name, string_types) or not name:
        raise BridgeError("Не хватает поля 'param'.")
    params = list(dev.parameters)
    low = name.lower()
    match = next((p for p in params if _text(p.name) == name), None)
    if match is None:
        match = next((p for p in params if _text(p.name).lower() == low), None)
    aliases = PARAM_ALIASES.get(_text(getattr(dev, "class_name", "")), {})
    if match is None and low in aliases:
        match = next((p for p in params if _text(p.name).lower() == aliases[low].lower()), None)
    if match is None:
        raise BridgeError("Параметра '%s' в %s нет (есть: %s)." % (
            name, _text(dev.name), ", ".join(_text(p.name) for p in params)))
    return match


def _display_number(param, raw):
    m = _NUM_RE.search(_display(param, raw))
    return float(m.group(0).replace(",", ".")) if m else None


def _coerce_value(param, value):
    """Сырое значение параметра из числа или строки так, как её показывает Live."""
    if isinstance(value, bool):
        value = 1 if value else 0
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, string_types):
        raise BridgeError("'value' - число или строка, как её показывает Live.")
    text = value.strip()
    if getattr(param, "is_quantized", False):
        items = [_text(i) for i in param.value_items]
        for test in (lambda a: a == text, lambda a: a.lower() == text.lower(),
                     lambda a: a.lower().replace(" ", "") == text.lower().replace(" ", "")):
            for i, it in enumerate(items):
                if test(it):
                    return float(i)
        raise BridgeError("'%s' не из списка %s для '%s'." % (text, items, _text(param.name)))
    lo, hi = int(param.min), int(param.max)
    if float(lo) == param.min and float(hi) == param.max and hi - lo <= 512:
        for i in range(lo, hi + 1):
            if _display(param, float(i)).lower() == text.lower():
                return float(i)
    m = _NUM_RE.search(text)
    if not m:
        raise BridgeError("Не вижу числа в '%s'." % text)
    number = float(m.group(0).replace(",", "."))
    lo, hi = float(param.min), float(param.max)
    if lo <= number <= hi and _display_number(param, number) == number:
        return number
    increasing = (_display_number(param, hi) or 0) >= (_display_number(param, lo) or 0)
    for _ in range(60):  # проценты, дБ: ищем сырое значение по показанному
        mid = (lo + hi) / 2.0
        shown = _display_number(param, mid)
        if shown is None:
            break
        if (shown < number) == increasing:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def cmd_set_param(ctx, args):
    index, track = _track_arg(ctx, args)
    _need_hint(track, "менять параметры его устройств нельзя")
    dev = _device(track, args.get("device", 0))
    param = _find_param(dev, args.get("param"))
    if "value" not in args:
        raise BridgeError("Не хватает поля 'value'.")
    if not param.is_enabled:
        raise BridgeError("Параметр '%s' сейчас недоступен." % _text(param.name))
    raw = _coerce_value(param, args["value"])
    if raw < param.min or raw > param.max:
        raise BridgeError("Значение %s вне диапазона [%s, %s] для '%s'." % (
            args["value"], param.min, param.max, _text(param.name)))
    param.value = raw
    return {"track": index, "device": _text(dev.name), "param": _text(param.name), "value": param.value,
            "display": _display(param)}


def cmd_remove(ctx, args):
    index, track = _track_arg(ctx, args)
    _need_hint(track, "удалять его нельзя")
    if args.get("confirmed") is not True:
        raise BridgeError(
            "Удалить трек «%s» можно только после явного «да» ученика в чате. Спроси его и повтори с "
            "confirmed: true." % _text(track.name))
    name = _text(track.name)
    ctx.song.delete_track(index)
    return {"removed": name, "index": index}


def cmd_fire_clip(ctx, args):
    index, track = _track_arg(ctx, args)
    slot_index, slot = _slot(track, args)
    if not slot.has_clip:
        raise BridgeError("Слот %d на треке «%s» пуст: играть нечего." % (slot_index, _text(track.name)))
    slot.fire()
    return {"fired": True, "track": index, "slot": slot_index}


def cmd_stop(ctx, args):
    ctx.song.stop_all_clips()
    stop = getattr(ctx.song, "stop_playing", None)
    if stop:
        stop()
    return {"stopped": True}


COMMANDS = {
    "ping": cmd_ping,
    "song": cmd_song,
    "tracks": cmd_tracks,
    "clip_notes": cmd_clip_notes,
    "browser": cmd_browser,
    "add_midi_track": cmd_add_midi_track,
    "add_clip": cmd_add_clip,
    "load_device": cmd_load_device,
    "set_param": cmd_set_param,
    "remove": cmd_remove,
    "fire_clip": cmd_fire_clip,
    "stop": cmd_stop,
}

# Команды, которых в мосте нет и не будет: на них отвечаем не «неизвестно», а объяснением запрета.
FORBIDDEN = {
    "set_clip": "править существующий клип",
    "create_clip": "создавать клипы мимо проверок (используй add_clip)",
    "delete_clip": "удалять клипы",
    "set_notes": "менять ноты",
    "remove_notes": "удалять ноты",
    "delete_track": "удалять треки (используй remove для трека-подсказки)",
    "delete_device": "удалять устройства",
    "set_tempo": "менять темп",
    "set_track_name": "переименовывать треки",
    "set_volume": "менять микшер",
    "set_pan": "менять микшер",
    "set_mute": "менять микшер",
    "set_solo": "менять микшер",
    "to_arrangement": "переносить клипы в Arrangement",
    "create_midi_track": "создавать треки мимо проверок (используй add_midi_track)",
    "browser_load": "загружать устройства мимо проверок (используй load_device)",
}


def _forbidden(what):
    def handler(ctx, args):
        raise BridgeError(
            "Мост не умеет %s: он только читает проект ученика и добавляет свои треки «%s…» и клипы в пустые "
            "слоты. Предложи это ученику словами - пусть сделает сам." % (what, PREFIX))
    handler.forbidden = True
    return handler


for _name, _what in FORBIDDEN.items():
    COMMANDS.setdefault(_name, _forbidden(_what))
