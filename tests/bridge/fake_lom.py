# -*- coding: utf-8 -*-
"""Фейковая объектная модель Live для тестов моста (Python 2.7 и 3).

Два профиля заметок: «Live 11+» (add_new_notes / get_notes_extended) и «Live 10»
(только set_notes / get_notes с другим порядком аргументов). Структура по образцу
test_agent_bridge.py из agent_tools автора.
"""
from __future__ import unicode_literals

import types


class NS(object):
    """types.SimpleNamespace, которого нет в Python 2."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


class FakeParam(object):
    def __init__(self, name, value=0.0, lo=0.0, hi=1.0, items=None, fmt=None):
        self.name, self.value, self.min, self.max = name, value, lo, hi
        self.value_items = items or []
        self.is_quantized = bool(items)
        self.is_enabled = True
        self._fmt = fmt

    def str_for_value(self, v):
        if self.is_quantized:
            return self.value_items[int(v)]
        return self._fmt(v) if self._fmt else "%g" % v


class FakeArp(object):
    class_name = "MidiArpeggiator"
    name = "Arpeggiator"

    def __init__(self):
        self.parameters = [
            FakeParam("Style", 0, 0, 3, items=["Up", "Down", "UpDown", "DownUp"]),
            FakeParam("Synced Rate", 0, 0, 2, items=["1/4", "1/8", "1/16"]),
            FakeParam("Gate", 0.5, 0, 2, fmt=lambda v: "%d %%" % round(v * 100)),
        ]


class FakeSynth(object):
    class_name = "InstrumentVector"
    name = "Wavetable"

    def __init__(self):
        self.parameters = [FakeParam("Volume", 0.5, 0, 1)]


class FakeNote(object):
    def __init__(self, **kw):
        self.pitch, self.start_time = kw["pitch"], kw["start_time"]
        self.duration, self.velocity = kw["duration"], kw["velocity"]


class _ClipBase(object):
    is_midi_clip = True
    is_playing = False

    def __init__(self, length):
        self.name = ""
        self.color = 0
        self.length = float(length)
        self.loop_end = float(length)
        self.end_marker = float(length)
        self.loop_start = 0.0
        self._notes = []  # (pitch, start, duration, velocity)
        self.fail_add = False


class ClipModern(_ClipBase):
    """Live 11/12."""

    def add_new_notes(self, specs):
        if self.fail_add:
            raise RuntimeError("add_new_notes refused")
        for s in specs:
            self._notes.append((s.pitch, s.start_time, s.duration, s.velocity))

    def get_notes_extended(self, from_pitch, pitch_span, from_time, time_span):
        return [FakeNote(pitch=p, start_time=s, duration=d, velocity=v) for (p, s, d, v) in self._notes
                if from_pitch <= p < from_pitch + pitch_span and from_time <= s < from_time + time_span]


class ClipLegacy(_ClipBase):
    """Live 10: ни add_new_notes, ни get_notes_extended."""

    def set_notes(self, notes):
        if self.fail_add:
            raise RuntimeError("set_notes refused")
        for n in notes:
            assert len(n) == 5, "set_notes ждёт (pitch, time, duration, velocity, mute)"
            self._notes.append(tuple(n[:4]))

    def get_notes(self, from_time, from_pitch, time_span, pitch_span):
        return tuple((p, s, d, v, False) for (p, s, d, v) in self._notes
                     if from_pitch <= p < from_pitch + pitch_span and from_time <= s < from_time + time_span)


class FakeAudioClip(object):
    is_midi_clip = False
    is_playing = False
    length = 8.0

    def __init__(self, name="Loop"):
        self.name = name


class FakeSlot(object):
    def __init__(self, clip_cls):
        self.clip = None
        self.fired = 0
        self._clip_cls = clip_cls
        self.created = 0
        self.deleted = 0

    @property
    def has_clip(self):
        return self.clip is not None

    def create_clip(self, length):
        self.created += 1
        self.clip = self._clip_cls(length)

    def delete_clip(self):
        self.deleted += 1
        self.clip = None

    def fire(self):
        self.fired += 1


class FakeTrack(object):
    def __init__(self, name, clip_cls, midi=True, scenes=4):
        self.name, self.has_midi_input, self.devices = name, midi, []
        self.color = 0
        self.clip_slots = [FakeSlot(clip_cls) for _ in range(scenes)]
        self.volume = 0.85  # микшер ученика: тест проверяет, что мост его не трогает


class BrowserItem(object):
    def __init__(self, name, children=None, loadable=False):
        self.name, self.children, self.is_loadable = name, children or [], loadable


class FakeBrowser(object):
    def __init__(self, song):
        self.instruments = BrowserItem("instruments", [BrowserItem("Wavetable", loadable=True),
                                                       BrowserItem("Pads", [BrowserItem("Warm.adg", loadable=True)])])
        self.midi_effects = BrowserItem("midi_effects", [BrowserItem("Arpeggiator", loadable=True)])
        self.audio_effects = BrowserItem("audio_effects", [])
        self.fail_load = False
        self._song = song

    def load_item(self, item):
        if self.fail_load:
            return
        track = self._song.view.selected_track
        track.devices.append({"Arpeggiator": FakeArp}.get(item.name, FakeSynth)())


class FakeSong(object):
    def __init__(self, clip_cls, max_tracks=None):
        self.clip_cls = clip_cls
        self.max_tracks = max_tracks
        self.tracks = []
        self.scenes = [object() for _ in range(4)]
        self.tempo = 120.0
        self.signature_numerator, self.signature_denominator = 4, 4
        self.is_playing = False
        self.view = NS(selected_track=None, selected_scene=None, detail_clip=None)
        self.stopped = 0
        self.tempo_writes = 0

    def create_midi_track(self, index):
        if self.max_tracks is not None and len(self.tracks) >= self.max_tracks:
            raise RuntimeError("Track limit reached")
        track = FakeTrack("%d-MIDI" % (len(self.tracks) + 1), self.clip_cls)
        self.tracks.insert(len(self.tracks) if index == -1 else index, track)

    def delete_track(self, index):
        del self.tracks[index]

    def stop_all_clips(self):
        self.stopped += 1

    def stop_playing(self):
        self.is_playing = False


class FakeApp(object):
    def __init__(self, song, version=(12, 1, 5)):
        self.browser = FakeBrowser(song)
        self._v = version

    def get_major_version(self):
        return self._v[0]

    def get_minor_version(self):
        return self._v[1]

    def get_bugfix_version(self):
        return self._v[2]


def make_ctx(profile="modern", max_tracks=None):
    clip_cls = ClipModern if profile == "modern" else ClipLegacy
    song = FakeSong(clip_cls, max_tracks)
    clip_ns = NS(MidiNoteSpecification=FakeNote) if profile == "modern" else NS()
    live = NS(Clip=clip_ns)
    version = (12, 1, 5) if profile == "modern" else (10, 1, 18)
    return NS(song=song, live=live, application=FakeApp(song, version), log=lambda m: None)


def learner_project(ctx):
    """Проект ученика: MIDI-трек с клипом «Мой бас» в слоте 0 и аудиотрек с «Loop»."""
    song = ctx.song
    song.create_midi_track(-1)
    bass = song.tracks[0]
    bass.name = "Бас"
    bass.devices.append(FakeSynth())
    bass.clip_slots[0].create_clip(4)
    clip = bass.clip_slots[0].clip
    clip.name = "Мой бас"
    clip._notes.append((36, 0.0, 1.0, 100))
    audio = FakeTrack("Ударные", ctx.song.clip_cls, midi=False)
    audio.clip_slots[1].clip = FakeAudioClip()
    song.tracks.append(audio)
    return bass, audio
