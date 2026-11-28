# -*- coding: utf-8 -*-
"""Тесты MentorBridge на фейковой модели Live. Один файл работает под Python 2.7 и 3.

Запуск из корня репозитория: python tests/bridge/test_mentor_bridge.py   (python2 - так же)
"""
from __future__ import unicode_literals

import io
import json
import os
import re
import socket
import sys
import threading
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "bridge"))

# Фреймворка Live на хосте нет: подставляем ровно столько, чтобы импортировался __init__ пакета.
_cs = types.ModuleType(str("_Framework.ControlSurface"))
_cs.ControlSurface = type(str("ControlSurface"), (object,), {})
sys.modules.setdefault(str("_Framework"), types.ModuleType(str("_Framework")))
sys.modules.setdefault(str("_Framework.ControlSurface"), _cs)

from MentorBridge import commands, protocol, server  # noqa: E402
import fake_lom  # noqa: E402

PREFIX = commands.PREFIX


def call(ctx, **req):
    return json.loads(protocol.dispatch(json.dumps(req), commands.COMMANDS, ctx))


class Base(object):
    profile = "modern"

    def setUp(self):
        self.ctx = fake_lom.make_ctx(self.profile)
        self.bass, self.audio = fake_lom.learner_project(self.ctx)

    def snapshot(self):
        """Всё, что принадлежит ученику: если мост что-то тронул, снимок изменится."""
        out = []
        for t in self.ctx.song.tracks:
            if t.name.startswith(PREFIX):
                continue
            out.append((t.name, t.volume, t.color, [d.name for d in t.devices],
                        [(s.clip.name, sorted(getattr(s.clip, "_notes", []))) if s.clip else None
                         for s in t.clip_slots]))
        return out, self.ctx.song.tempo

    def refuses(self, expect, **req):
        before = self.snapshot()
        resp = call(self.ctx, **req)
        self.assertFalse(resp["ok"], resp)
        self.assertIn(expect, resp["error"])
        self.assertEqual(self.snapshot(), before, "мост изменил проект ученика при отказе")
        return resp

    def hint(self, name="идея"):
        r = call(self.ctx, cmd="add_midi_track", name=name)
        self.assertTrue(r["ok"], r)
        return r["result"]["index"]


class DispatchTests(Base, unittest.TestCase):
    def test_ping_has_versions(self):
        r = call(self.ctx, cmd="ping")["result"]
        self.assertEqual((r["pong"], r["bridge"]), (True, "MentorBridge"))
        self.assertEqual(r["live"], "12.1.5")
        self.assertIn(".", r["python"])

    def test_bad_requests(self):
        for line in ["not json", "[1]", "{}", '{"cmd": 5}', ""]:
            resp = json.loads(protocol.dispatch(line, commands.COMMANDS, self.ctx))
            self.assertFalse(resp["ok"], line)
            self.assertIn("error", resp)

    def test_unknown_command_lists_only_real_ones(self):
        resp = call(self.ctx, cmd="nope")
        self.assertFalse(resp["ok"])
        self.assertIn("Неизвестная команда 'nope'", resp["error"])
        self.assertIn("add_clip", resp["error"])
        self.assertNotIn("set_notes", resp["error"])

    def test_exception_does_not_kill(self):
        logged = []
        resp = json.loads(protocol.dispatch('{"cmd":"boom"}', {"boom": lambda c, a: 1 / 0}, None, logged.append))
        self.assertFalse(resp["ok"])
        self.assertIn("ZeroDivisionError", resp["error"])
        self.assertTrue(logged)

    def test_id_echoed_and_response_is_ascii(self):
        line = protocol.dispatch('{"cmd":"ping","id":7}', commands.COMMANDS, self.ctx)
        line.encode("ascii")
        self.assertEqual(json.loads(line)["id"], 7)


class ReadTests(Base, unittest.TestCase):
    def test_song_and_tracks(self):
        s = call(self.ctx, cmd="song")["result"]
        self.assertEqual((s["tempo"], s["signature"], s["track_count"], s["scene_count"]), (120.0, [4, 4], 2, 4))
        t = call(self.ctx, cmd="tracks")["result"]["tracks"]
        self.assertEqual([x["name"] for x in t], ["Бас", "Ударные"])
        self.assertEqual(t[0]["clips"][0]["name"], "Мой бас")
        self.assertEqual(t[0]["clips"][0]["note_count"], 1)
        self.assertEqual(t[1]["type"], "audio")
        self.assertFalse(t[0]["hint"])

    def test_clip_notes(self):
        r = call(self.ctx, cmd="clip_notes", track="Бас", slot=0)["result"]
        self.assertEqual(r["notes"], [{"pitch": 36, "start": 0.0, "duration": 1.0, "velocity": 100}])
        self.assertEqual(call(self.ctx, cmd="clip_notes", track=0, slot=1)["result"], {"exists": False, "track": 0, "slot": 1})
        self.assertFalse(call(self.ctx, cmd="clip_notes", track=1, slot=1)["ok"])  # аудиоклип без нот

    def test_last_clip_finds_newest_recording(self):
        self.assertTrue(call(self.ctx, cmd="add_clip", track="Бас", slot=2, length_beats=4,
                             notes=[{"pitch": 40, "start": 0, "duration": 1}], name="моя запись")["ok"])
        r = call(self.ctx, cmd="last_clip", track="Бас")["result"]
        self.assertEqual((r["slot"], r["how"]), (2, "last"))
        self.assertEqual([n["pitch"] for n in r["notes"]], [40])

    def test_last_clip_prefers_playing_and_selected(self):
        self.assertTrue(call(self.ctx, cmd="add_clip", track="Бас", slot=2, length_beats=4,
                             notes=[{"pitch": 41, "start": 0, "duration": 1}], name="b")["ok"])
        # запись только что зациклилась в слоте 2 — он играет
        self.bass.clip_slots[2].clip.is_playing = True
        self.assertEqual(call(self.ctx, cmd="last_clip", track="Бас")["result"]["how"], "playing")
        self.bass.clip_slots[2].clip.is_playing = False
        # ученик выделил клип в первом слоте — уважаем выбор
        self.ctx.song.view.detail_clip = self.bass.clip_slots[0].clip
        r = call(self.ctx, cmd="last_clip", track="Бас")["result"]
        self.assertEqual((r["slot"], r["how"], r["name"]), (0, "selected", "Мой бас"))

    def test_last_clip_edges(self):
        self.assertEqual(call(self.ctx, cmd="last_clip", track="Бас")["result"]["how"], "last")
        empty = self.hint()  # пустой трек-подсказка
        r = call(self.ctx, cmd="last_clip", track=empty)["result"]
        self.assertEqual((r["exists"], r["slot_count"]), (False, 4))
        audio = call(self.ctx, cmd="last_clip", track="Ударные")["result"]
        self.assertEqual((audio["exists"], audio["is_midi_clip"]), (True, False))
        self.assertFalse(call(self.ctx, cmd="last_clip", track="Нет такого")["ok"])

    def test_browser(self):
        self.assertIn("instruments", call(self.ctx, cmd="browser")["result"]["roots"])
        r = call(self.ctx, cmd="browser", path="instruments")["result"]
        self.assertEqual([c["name"] for c in r["children"]], ["Wavetable", "Pads"])
        self.assertTrue(r["children"][0]["loadable"])
        self.assertFalse(call(self.ctx, cmd="browser", path="nope/x")["ok"])


class WriteTests(Base, unittest.TestCase):
    def test_add_midi_track_prefix_color(self):
        idx = self.hint("синт")
        t = self.ctx.song.tracks[idx]
        self.assertEqual(t.name, PREFIX + "синт")
        self.assertEqual(t.color, commands.HINT_COLOR)
        self.assertEqual(self.hint(PREFIX + "уже с префиксом") and self.ctx.song.tracks[-1].name, PREFIX + "уже с префиксом")

    def test_add_clip_on_hint_track(self):
        idx = self.hint()
        notes = [{"pitch": 60, "start": 0, "duration": 1, "velocity": 90}, {"pitch": 64, "start": 1, "duration": 1}]
        r = call(self.ctx, cmd="add_clip", track=idx, slot=0, length_beats=4, notes=notes, name="аккорд")
        self.assertTrue(r["ok"], r)
        clip = self.ctx.song.tracks[idx].clip_slots[0].clip
        self.assertEqual(clip.name, PREFIX + "аккорд")
        self.assertEqual(clip.color, commands.HINT_COLOR)
        back = call(self.ctx, cmd="clip_notes", track=idx, slot=0)["result"]["notes"]
        self.assertEqual([(n["pitch"], n["start"], n["velocity"]) for n in back], [(60, 0.0, 90), (64, 1.0, 100)])

    def test_add_clip_on_learner_midi_track_empty_slot(self):
        r = call(self.ctx, cmd="add_clip", track="Бас", slot=2, length_beats=4,
                 notes=[{"pitch": 40, "start": 0, "duration": 1}], name="вариант")
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.bass.clip_slots[2].clip.name, PREFIX + "вариант")
        self.assertEqual(self.bass.clip_slots[0].clip.name, "Мой бас")  # соседний клип цел

    def test_add_clip_into_occupied_slot_refused(self):
        r = self.refuses("занят клипом «Мой бас»", cmd="add_clip", track="Бас", slot=0, length_beats=4,
                         notes=[{"pitch": 40, "start": 0, "duration": 1}], name="x")
        self.assertIn("Первый пустой слот: 1", r["error"])
        self.assertEqual(self.bass.clip_slots[0].created, 1)  # только исходное создание проекта

    def test_add_clip_occupied_hint_slot_refused(self):
        idx = self.hint()
        self.assertTrue(call(self.ctx, cmd="add_clip", track=idx, slot=0, length_beats=4, name="a")["ok"])
        self.refuses("занят клипом", cmd="add_clip", track=idx, slot=0, length_beats=4, name="b")

    def test_add_clip_audio_track_and_missing_slot_refused(self):
        self.refuses("только на MIDI-трек", cmd="add_clip", track="Ударные", slot=0, length_beats=4)
        self.refuses("Слота 9 нет", cmd="add_clip", track="Бас", slot=9, length_beats=4)

    def test_add_clip_bad_notes_leaves_nothing(self):
        self.refuses("Нота 0", cmd="add_clip", track="Бас", slot=1, length_beats=4, notes=[{"pitch": 200, "start": 0, "duration": 1}])
        self.refuses("Нота 0 начинается", cmd="add_clip", track="Бас", slot=1, length_beats=4, notes=[{"pitch": 60, "start": 4, "duration": 1}])
        self.assertIsNone(self.bass.clip_slots[1].clip)

    def test_add_clip_failure_rolls_back_own_clip(self):
        self.bass.clip_slots[1]._clip_cls = type(str("Failing"), (type(self.bass.clip_slots[0].clip),), {
            "__init__": lambda s, n: (type(self.bass.clip_slots[0].clip).__init__(s, n), setattr(s, "fail_add", True))[0]})
        self.refuses("Клип не удалось заполнить", cmd="add_clip", track="Бас", slot=1, length_beats=4,
                     notes=[{"pitch": 60, "start": 0, "duration": 1}])
        self.assertIsNone(self.bass.clip_slots[1].clip)

    def test_load_device_and_set_param_on_hint_track(self):
        idx = self.hint()
        self.ctx.song.view.selected_track = self.bass
        r = call(self.ctx, cmd="load_device", track=idx, path="midi_effects/Arpeggiator")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["devices"], ["Arpeggiator"])
        self.assertIs(self.ctx.song.view.selected_track, self.bass)  # выбор ученика вернули
        self.assertEqual(self.bass.devices[0].name, "Wavetable")
        for param, value, shown in [("Style", "Up", "Up"), ("Rate", "1/8", "1/8"), ("Gate", "50 %", "50 %")]:
            r = call(self.ctx, cmd="set_param", track=idx, device="Arpeggiator", param=param, value=value)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["result"]["display"], shown)

    def test_load_device_not_loaded_is_error(self):
        idx = self.hint()
        self.ctx.application.browser.fail_load = True
        r = call(self.ctx, cmd="load_device", track=idx, path="instruments/Wavetable")
        self.assertFalse(r["ok"])
        self.assertIn("не загрузил", r["error"])
        self.assertFalse(call(self.ctx, cmd="load_device", track=idx, path="instruments/Pads")["ok"])  # папка

    def test_remove_needs_confirmation(self):
        idx = self.hint()
        r = call(self.ctx, cmd="remove", track=idx)
        self.assertFalse(r["ok"])
        self.assertIn("«да»", r["error"])
        self.assertFalse(call(self.ctx, cmd="remove", track=idx, confirmed="true")["ok"])
        self.assertEqual(len(self.ctx.song.tracks), 3)
        self.assertTrue(call(self.ctx, cmd="remove", track=idx, confirmed=True)["ok"])
        self.assertEqual([t.name for t in self.ctx.song.tracks], ["Бас", "Ударные"])

    def test_fire_and_stop(self):
        self.assertTrue(call(self.ctx, cmd="fire_clip", track=0, slot=0)["ok"])
        self.assertEqual(self.bass.clip_slots[0].fired, 1)
        self.assertFalse(call(self.ctx, cmd="fire_clip", track=0, slot=3)["ok"])
        self.assertTrue(call(self.ctx, cmd="stop")["ok"])
        self.assertEqual(self.ctx.song.stopped, 1)

    def test_track_limit_is_understandable(self):
        ctx = fake_lom.make_ctx(self.profile, max_tracks=2)
        fake_lom.learner_project(ctx)
        r = call(ctx, cmd="add_midi_track", name="x")
        self.assertFalse(r["ok"])
        self.assertIn("число треков ограничено", r["error"])
        self.assertNotIn("Traceback", r["error"])
        self.assertEqual(len(ctx.song.tracks), 2)


class ForbiddenTests(Base, unittest.TestCase):
    """Каждый отказ запрета: проект ученика остаётся ровно таким же."""

    def test_set_param_on_learner_track(self):
        self.refuses("Это трек ученика «Бас»", cmd="set_param", track="Бас", device="Wavetable", param="Volume", value=0.1)
        self.assertEqual(self.bass.devices[0].parameters[0].value, 0.5)

    def test_load_device_on_learner_track(self):
        self.refuses("Это трек ученика", cmd="load_device", track="Бас", path="instruments/Wavetable")
        self.assertEqual(len(self.bass.devices), 1)

    def test_remove_learner_track_even_confirmed(self):
        self.refuses("Это трек ученика", cmd="remove", track="Бас", confirmed=True)
        self.assertEqual(len(self.ctx.song.tracks), 2)

    def test_remove_learner_track_by_index(self):
        self.refuses("Это трек ученика", cmd="remove", track=1, confirmed=True)

    def test_remove_by_lookalike_name_is_not_hint(self):
        self.bass.name = "Подсказка без двоеточия"
        self.refuses("Это трек ученика", cmd="remove", track=0, confirmed=True)

    def test_writes_that_do_not_exist(self):
        for cmd, extra in [("set_clip", {}), ("set_notes", {}), ("remove_notes", {}), ("delete_clip", {}),
                           ("delete_track", {"track": 0}), ("delete_device", {}), ("set_tempo", {"tempo": 90}),
                           ("set_track_name", {"track": 0, "name": "x"}), ("set_volume", {"track": 0, "value": 0}),
                           ("set_pan", {}), ("set_mute", {}), ("set_solo", {}), ("to_arrangement", {}),
                           ("create_clip", {"track": 0, "slot": 3, "length_beats": 4}),
                           ("create_midi_track", {}), ("browser_load", {"path": "instruments/Wavetable"})]:
            req = dict(extra, cmd=cmd)
            r = self.refuses("Мост не умеет", **req)
            self.assertNotIn("Неизвестная", r["error"])
        self.assertEqual(self.ctx.song.tempo, 120.0)
        self.assertEqual(len(self.ctx.song.tracks), 2)

    def test_hint_clip_slot_on_audio_clip_track(self):
        self.refuses("только на MIDI-трек", cmd="add_clip", track=1, slot=1, length_beats=4)


class FileTests(Base, unittest.TestCase):
    """files_list / file_read: только .als/.wav и только внутри корней."""

    def setUp(self):
        import base64
        import shutil
        import tempfile
        Base.setUp(self)
        self.b64 = base64
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="mm_files_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.projects = os.path.join(self.home, "Documents", "Проекты")
        os.makedirs(os.path.join(self.projects, "Backup"))
        os.makedirs(os.path.join(self.tmp, "outside"))
        self.song = os.path.join(self.projects, "Ночь.als")
        self.wav = os.path.join(self.projects, "mix.wav")
        self.secret = os.path.join(self.tmp, "outside", "secret.als")
        self.payload = bytes(bytearray(i % 251 for i in range(1300)))
        for path in (self.song, self.wav, self.secret, os.path.join(self.projects, "Backup", "old.als"),
                     os.path.join(self.projects, "notes.txt")):
            with open(path, "wb") as fh:
                fh.write(self.payload)
        self.saved = dict((k, os.environ.get(k)) for k in ("HOME", "USERPROFILE", "MM_PROJECT_DIRS"))
        os.environ[str("HOME")] = str(self.home)
        os.environ[str("USERPROFILE")] = str(self.home)
        os.environ.pop("MM_PROJECT_DIRS", None)
        del commands._granted[:]
        self.addCleanup(self.restore)

    def restore(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[str(k)] = v
        del commands._granted[:]

    def read_all(self, path, step):
        out, offset = b"", 0
        while True:
            r = call(self.ctx, cmd="file_read", path=path, offset=offset, length=step)
            self.assertTrue(r["ok"], r)
            out += self.b64.b64decode(r["result"]["data"])
            offset = len(out)
            if r["result"]["eof"]:
                return out, r["result"]

    def test_list_als_skips_backup_and_other_kinds(self):
        r = call(self.ctx, cmd="files_list", kind="als")["result"]
        self.assertEqual([f["path"] for f in r["files"]], [self.song])
        self.assertEqual(r["files"][0]["size"], 1300)
        self.assertGreater(r["files"][0]["mtime"], 0)
        w = call(self.ctx, cmd="files_list", kind="wav")["result"]
        self.assertEqual([f["path"] for f in w["files"]], [self.wav])

    def test_roots_only_does_not_walk(self):
        r = call(self.ctx, cmd="files_list", kind="als", roots_only=True)["result"]
        self.assertEqual(r["files"], [])
        self.assertIn(os.path.join(self.home, "Documents"), r["roots"])
        self.assertTrue(r["home"])

    def test_list_bad_kind(self):
        self.assertFalse(call(self.ctx, cmd="files_list", kind="exe")["ok"])

    def test_read_in_chunks_matches_file(self):
        data, last = self.read_all(self.wav, 500)
        self.assertEqual(data, self.payload)
        self.assertEqual(last["size"], 1300)

    def test_read_length_capped(self):
        r = call(self.ctx, cmd="file_read", path=self.wav, offset=0, length=10 ** 9)["result"]
        self.assertEqual(len(self.b64.b64decode(r["data"])), 1300)
        self.assertTrue(r["eof"])
        mid = call(self.ctx, cmd="file_read", path=self.wav, offset=0, length=100)["result"]
        self.assertFalse(mid["eof"])

    def test_read_outside_roots_refused(self):
        resp = call(self.ctx, cmd="file_read", path=self.secret, offset=0, length=10)
        self.assertFalse(resp["ok"])
        self.assertIn("вне папок", resp["error"])

    def test_read_traversal_refused(self):
        sneaky = os.path.join(self.projects, "..", "..", "..", "outside", "secret.als")
        self.assertFalse(call(self.ctx, cmd="file_read", path=sneaky, offset=0, length=10)["ok"])

    @unittest.skipIf(not hasattr(os, "symlink"), "нет symlink")
    def test_read_symlink_out_refused(self):
        link = os.path.join(self.projects, "link.als")
        try:
            os.symlink(self.secret, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink не создаётся")
        resp = call(self.ctx, cmd="file_read", path=link, offset=0, length=10)
        self.assertFalse(resp["ok"])
        self.assertIn("вне папок", resp["error"])

    def test_read_other_extension_refused(self):
        resp = call(self.ctx, cmd="file_read", path=os.path.join(self.projects, "notes.txt"), offset=0, length=10)
        self.assertFalse(resp["ok"])
        self.assertIn("только .als и .wav", resp["error"])

    def test_read_bad_args_and_missing(self):
        self.assertFalse(call(self.ctx, cmd="file_read", offset=0, length=10)["ok"])
        self.assertFalse(call(self.ctx, cmd="file_read", path=self.wav, offset=-1, length=10)["ok"])
        self.assertFalse(call(self.ctx, cmd="file_read", path=self.wav, offset=0, length=0)["ok"])
        missing = os.path.join(self.projects, "нет.als")
        self.assertIn("нет", call(self.ctx, cmd="file_read", path=missing, offset=0, length=10)["error"])

    def test_extra_root_listed_then_readable(self):
        extra = os.path.join(self.tmp, "outside")
        self.assertFalse(call(self.ctx, cmd="file_read", path=self.secret, offset=0, length=10)["ok"])
        r = call(self.ctx, cmd="files_list", kind="als", roots=[extra])["result"]
        self.assertIn(self.secret, [f["path"] for f in r["files"]])
        self.assertTrue(call(self.ctx, cmd="file_read", path=self.secret, offset=0, length=10)["ok"])

    def test_mm_project_dirs(self):
        os.environ[str("MM_PROJECT_DIRS")] = str(os.path.join(self.tmp, "outside"))
        self.assertTrue(call(self.ctx, cmd="file_read", path=self.secret, offset=0, length=10)["ok"])

    def test_commands_not_forbidden_and_ping_version(self):
        self.assertFalse(getattr(commands.COMMANDS["file_read"], "forbidden", False))
        self.assertGreaterEqual(call(self.ctx, cmd="ping")["result"]["version"], 3)


class NoteShimTests(unittest.TestCase):
    def roundtrip(self, profile):
        ctx = fake_lom.make_ctx(profile)
        fake_lom.learner_project(ctx)
        idx = call(ctx, cmd="add_midi_track", name="т")["result"]["index"]
        notes = [{"pitch": 55, "start": 0.5, "duration": 0.5, "velocity": 80}, {"pitch": 48, "start": 0, "duration": 2}]
        self.assertTrue(call(ctx, cmd="add_clip", track=idx, slot=0, length_beats=4, notes=notes, name="n")["ok"])
        clip = ctx.song.tracks[idx].clip_slots[0].clip
        back = call(ctx, cmd="clip_notes", track=idx, slot=0)["result"]["notes"]
        self.assertEqual([(n["pitch"], n["start"], n["duration"], n["velocity"]) for n in back],
                         [(48, 0.0, 2.0, 100), (55, 0.5, 0.5, 80)])
        return clip

    def test_live_11_plus_uses_extended_api(self):
        clip = self.roundtrip("modern")
        self.assertTrue(hasattr(clip, "add_new_notes") and not hasattr(clip, "set_notes"))

    def test_live_10_uses_set_notes_get_notes(self):
        clip = self.roundtrip("legacy")
        self.assertTrue(hasattr(clip, "set_notes") and not hasattr(clip, "add_new_notes"))
        self.assertFalse(hasattr(clip, "get_notes_extended"))

    def test_live_10_ping_and_tracks_without_arrangement_clips(self):
        ctx = fake_lom.make_ctx("legacy")
        fake_lom.learner_project(ctx)
        self.assertEqual(call(ctx, cmd="ping")["result"]["live"], "10.1.18")
        tracks = call(ctx, cmd="tracks")["result"]["tracks"]
        self.assertNotIn("arrangement_clips", tracks[0])
        self.assertEqual(tracks[0]["clips"][0]["note_count"], 1)


class ServerTests(unittest.TestCase):
    """Сокет-поток только кладёт строки в очередь; LOM - в потоке poll()."""

    def setUp(self):
        self.ctx = fake_lom.make_ctx("modern")
        fake_lom.learner_project(self.ctx)
        self.seen_threads = []
        self.srv = server.BridgeServer("127.0.0.1", 0)
        self.srv.start()
        self.stop = threading.Event()
        self.poll_ident = []

        def handler(line):
            self.seen_threads.append(threading.current_thread().ident)
            return protocol.dispatch(line, commands.COMMANDS, self.ctx)

        def loop():
            self.poll_ident.append(threading.current_thread().ident)
            while not self.stop.is_set():
                self.srv.poll(handler)
                self.stop.wait(0.01)

        self.thread = threading.Thread(target=loop)
        self.thread.daemon = True
        self.thread.start()

    def tearDown(self):
        self.stop.set()
        self.thread.join(2)
        self.srv.stop()

    def ask(self, sock_file, sock, line):
        sock.sendall((line + "\n").encode("utf-8"))
        return json.loads(sock_file.readline().decode("utf-8"))

    def test_roundtrip_one_line_one_answer(self):
        sock = socket.create_connection(("127.0.0.1", self.srv.port), 5)
        f = sock.makefile("rb")
        try:
            self.assertTrue(self.ask(f, sock, '{"cmd":"ping","id":1}')["ok"])
            r = self.ask(f, sock, json.dumps({"cmd": "add_midi_track", "name": "кириллица"}, ensure_ascii=False))
            self.assertEqual(r["result"]["name"], PREFIX + "кириллица")
            self.assertFalse(self.ask(f, sock, "это не json")["ok"])
            self.assertTrue(self.ask(f, sock, '{"cmd":"ping"}')["ok"])  # после ошибки скрипт жив
        finally:
            f.close()
            sock.close()
        self.assertEqual(set(self.seen_threads), set(self.poll_ident))  # LOM только в потоке poll

    def test_port_constant(self):
        import MentorBridge
        self.assertEqual(MentorBridge.PORT, 9878)


class SourceRulesTests(unittest.TestCase):
    """Один код для Python 2.7 и 3: в мосте нет того, что 2.7 не знает."""

    def test_no_py3_only_syntax(self):
        root = os.path.join(HERE, "..", "..", "bridge", "MentorBridge")
        for name in os.listdir(root):
            if not name.endswith(".py"):
                continue
            with io.open(os.path.join(root, name), encoding="utf-8") as fh:
                src = fh.read()
            self.assertIsNone(re.search(r"os\.replace\(", src), name)
            self.assertIsNone(re.search(r"(?m)(?<![A-Za-z0-9_])f[\"']", src), name + ": f-строка")
            self.assertNotIn("nonlocal ", src, name)
            self.assertIn("unicode_literals", src, name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
