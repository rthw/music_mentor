/**
 * Чтение .als (gzip XML) в плоскую модель проекта. Работает для Live 9–12:
 * отличия форматов закрыты здесь, остальной код про версии не знает.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { bool, child, find, num, parseXml, val, type XmlNode } from "./xml.ts";

export interface Note {
	pitch: number;
	/** Начало в долях (четвертных) от начала клипа (внутреннее время клипа, как в Live). */
	start: number;
	duration: number;
	velocity: number;
}

export interface Clip {
	name: string;
	kind: "midi" | "audio";
	where: "session" | "arrangement";
	/** Позиция: для Arrangement — доля от начала проекта, для Session — номер сцены (0-based). */
	start: number;
	/** Длина в долях (Arrangement: CurrentEnd - CurrentStart; Session: длина цикла). */
	length: number;
	scene?: number;
	loopStart: number;
	loopEnd: number;
	looped: boolean;
	notes: Note[];
	sample?: string;
}

export type TrackType = "midi" | "audio" | "group" | "return" | "main";

export interface Track {
	id: string;
	type: TrackType;
	name: string;
	color: string;
	muted: boolean;
	groupId: string;
	devices: string[];
	clips: Clip[];
	volumeAutomation: boolean;
}

export interface Locator {
	time: number;
	name: string;
}

export interface Project {
	file: string;
	creator: string;
	/** Номер версии Live, например 10.1.18. */
	liveVersion: string;
	liveMajor: number;
	tempo: number;
	timeSignature: [number, number];
	scale?: { root: number; name: string; inKey: boolean };
	locators: Locator[];
	tracks: Track[];
	/** Длина аранжировки в долях: конец последнего клипа Arrangement. */
	arrangementLength: number;
	sceneCount: number;
}

const DEVICE_NAMES: Record<string, string> = {
	InstrumentVector: "Wavetable",
	OriginalSimpler: "Simpler",
	MultiSampler: "Sampler",
	UltraAnalog: "Analog",
	StringStudio: "Collision/Tension",
	LoungeLizard: "Electric",
	Tension: "Tension",
	Collision: "Collision",
	Operator: "Operator",
	Drift: "Drift",
	Meld: "Meld",
	Roar: "Roar",
	DrumGroupDevice: "Drum Rack",
	InstrumentGroupDevice: "Instrument Rack",
	AudioEffectGroupDevice: "Audio Effect Rack",
	MidiEffectGroupDevice: "MIDI Effect Rack",
	Compressor2: "Compressor",
	GlueCompressor: "Glue Compressor",
	Eq8: "EQ Eight",
	FilterEQ3: "EQ Three",
	AutoFilter: "Auto Filter",
	AutoPan: "Auto Pan",
	Reverb: "Reverb",
	Delay: "Simple Delay",
	FilterDelay: "Filter Delay",
	PingPongDelay: "Ping Pong Delay",
	Echo: "Echo",
	Limiter: "Limiter",
	Gate: "Gate",
	Saturator: "Saturator",
	Redux: "Redux",
	Erosion: "Erosion",
	Chorus: "Chorus",
	Chorus2: "Chorus-Ensemble",
	Phaser: "Phaser",
	PhaserNew: "Phaser-Flanger",
	Flanger: "Flanger",
	Corpus: "Corpus",
	Resonator: "Resonators",
	Vocoder: "Vocoder",
	Amp: "Amp",
	Cabinet: "Cabinet",
	Overdrive: "Overdrive",
	Pedal: "Pedal",
	Tuner: "Tuner",
	Utility: "Utility",
	StereoGain: "Utility",
	Hybrid: "Hybrid Reverb",
	Spectrum: "Spectrum",
	Arpeggiator: "Arpeggiator",
	MidiArpeggiator: "Arpeggiator",
	MidiChord: "Chord",
	MidiScale: "Scale",
	MidiPitcher: "Pitch",
	MidiRandom: "Random",
	MidiVelocity: "Velocity",
	MidiNoteLength: "Note Length",
	Looper: "Looper",
	Transmute: "Transmute",
	DrumBuss: "Drum Buss",
	MxDeviceMidiEffect: "Max MIDI Effect",
	MxDeviceInstrument: "Max Instrument",
	MxDeviceAudioEffect: "Max Audio Effect",
	CompressorDevice: "Compressor",
	BeatRepeat: "Beat Repeat",
	FrequencyShifter: "Frequency Shifter",
	GrainDelay: "Grain Delay",
	SpectralResonator: "Spectral Resonator",
	SpectralTime: "Spectral Time",
	ChannelEq: "Channel EQ",
	Shifter: "Shifter",
	MultibandDynamics: "Multiband Dynamics",
	DynamicTube: "Dynamic Tube",
	Emit: "Emit",
	Granulator: "Granulator",
	Warp: "Warp",
	ProxyAudioEffectDevice: "Effect (неактивен)",
};

/** Имя устройства в человеческом виде: пользовательское имя, имя плагина или перевод класса. */
export function deviceName(node: XmlNode): string {
	const user = val(node, "UserName");
	const plug = val(node, "PluginDesc/VstPluginInfo/PlugName") ?? val(node, "PluginDesc/Vst3PluginInfo/Name") ?? val(node, "PluginDesc/AuPluginInfo/Name");
	const own = plug ? `${plug} (плагин)` : (DEVICE_NAMES[node.tag] ?? node.tag);
	// переименованное пользователем устройство: показываем и его имя, и что это за устройство
	return user && user !== plug && user !== own ? `${user} [${own}]` : own;
}

const SCALE_NAMES = [
	"Major",
	"Minor",
	"Dorian",
	"Mixolydian",
	"Lydian",
	"Phrygian",
	"Locrian",
	"Whole Tone",
	"Half-whole Dim.",
	"Whole-half Dim.",
	"Minor Blues",
	"Minor Pentatonic",
	"Major Pentatonic",
	"Harmonic Minor",
	"Harmonic Major",
	"Melodic Minor",
	"Super Locrian",
	"Bhairav",
	"Hungarian Minor",
	"Minor Gypsy",
	"Hirajoshi",
	"In-Sen",
	"Iwato",
	"Kumoi",
	"Pelog Selected",
	"Spanish",
];

function parseClip(node: XmlNode, where: "session" | "arrangement", scene?: number): Clip {
	const kind = node.tag === "MidiClip" ? "midi" : "audio";
	const loopStart = num(node, "Loop/LoopStart");
	const loopEnd = num(node, "Loop/LoopEnd");
	const looped = bool(node, "Loop/LoopOn");
	let start = 0;
	let length = Math.max(0, loopEnd - loopStart);
	if (where === "arrangement") {
		start = num(node, "CurrentStart", Number(node.attrs.Time ?? 0));
		length = num(node, "CurrentEnd", start + length) - start;
	} else {
		start = scene ?? 0;
	}
	const clip: Clip = {
		name: val(node, "Name") ?? "",
		kind,
		where,
		start,
		length,
		loopStart,
		loopEnd,
		looped,
		notes: [],
	};
	if (scene !== undefined) clip.scene = scene;
	if (kind === "midi") {
		const keyTracks = find(node, "Notes/KeyTracks");
		for (const kt of keyTracks?.children ?? []) {
			const pitch = num(kt, "MidiKey", NaN);
			const events = find(kt, "Notes");
			for (const ev of events?.children ?? []) {
				if (ev.tag !== "MidiNoteEvent") continue;
				if (ev.attrs.IsEnabled === "false") continue;
				clip.notes.push({
					pitch,
					start: Number(ev.attrs.Time),
					duration: Number(ev.attrs.Duration),
					velocity: Number(ev.attrs.Velocity ?? 100),
				});
			}
		}
		clip.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
	} else {
		const sample = val(node, "SampleRef/FileRef/Name") ?? val(node, "SampleRef/FileRef/RelativePath");
		if (sample) clip.sample = sample.split(/[\\/]/).pop();
	}
	return clip;
}

function collectClips(seq: XmlNode | undefined): Clip[] {
	const clips: Clip[] = [];
	if (!seq) return clips;
	const slots = find(seq, "ClipSlotList")?.children ?? [];
	slots.forEach((slot, i) => {
		const holder = find(slot, "ClipSlot/Value");
		for (const c of holder?.children ?? []) if (c.tag === "MidiClip" || c.tag === "AudioClip") clips.push(parseClip(c, "session", i));
	});
	// Arrangement: MIDI — ClipTimeable, аудио — Sample (Live 9–12)
	for (const path of ["ClipTimeable/ArrangerAutomation/Events", "Sample/ArrangerAutomation/Events"]) {
		for (const c of find(seq, path)?.children ?? []) if (c.tag === "MidiClip" || c.tag === "AudioClip") clips.push(parseClip(c, "arrangement"));
	}
	return clips;
}

function parseTimeSignature(code: number): [number, number] {
	// Live кодирует размер одним числом: denominatorIndex * 99 + (numerator - 1)
	const numerator = (code % 99) + 1;
	const denominator = 2 ** Math.floor(code / 99);
	return [numerator, denominator];
}

function devicesOf(track: XmlNode): string[] {
	const list = find(track, "DeviceChain/DeviceChain/Devices") ?? find(track, "DeviceChain/Devices");
	return (list?.children ?? []).map(deviceName);
}

function trackColor(t: XmlNode): string {
	return val(t, "Color") ?? val(t, "ColorIndex") ?? "";
}

function hasVolumeAutomation(t: XmlNode, mixer: XmlNode | undefined): boolean {
	const volume = find(mixer, "Volume");
	const target = volume?.children.find((c) => c.tag === "AutomationTarget")?.attrs.Id;
	if (!target) return false;
	const envelopes = find(t, "AutomationEnvelopes/Envelopes");
	for (const env of envelopes?.children ?? []) {
		if (val(env, "EnvelopeTarget/PointeeId") === target) return (find(env, "Automation/Events")?.children.length ?? 0) > 1; // одно событие — просто текущее значение
	}
	return false;
}

export function parseProject(xml: string, file = ""): Project {
	const root = parseXml(xml);
	if (root.tag !== "Ableton") throw new Error("Это не проект Ableton Live: нет корневого элемента <Ableton>");
	const creator = root.attrs.Creator ?? "";
	const liveVersion = /(\d+(?:\.\d+)*)/.exec(creator)?.[1] ?? "";
	const liveMajor = Number(liveVersion.split(".")[0]) || 0;
	const set = child(root, "LiveSet");
	if (!set) throw new Error("В проекте нет <LiveSet>");
	const mainNode = child(set, "MainTrack") ?? child(set, "MasterTrack");
	const mixer = find(mainNode, "DeviceChain/Mixer");
	const tempo = num(mixer, "Tempo/Manual", 120);
	const timeSignature = parseTimeSignature(num(mixer, "TimeSignature/Manual", 201));

	const si = child(set, "ScaleInformation");
	let scale: Project["scale"];
	if (si && liveMajor >= 12) {
		const rawName = val(si, "Name") ?? "0";
		const name = /^\d+$/.test(rawName) ? (SCALE_NAMES[Number(rawName)] ?? `scale #${rawName}`) : rawName;
		scale = { root: num(si, "RootNote", num(si, "Root", 0)), name, inKey: bool(set, "InKey") };
	}

	const locators: Locator[] = [];
	for (const l of find(set, "Locators/Locators")?.children ?? []) {
		if (l.tag === "Locator") locators.push({ time: num(l, "Time"), name: val(l, "Name") ?? "" });
	}
	locators.sort((a, b) => a.time - b.time);

	const trackTypes: Record<string, TrackType> = {
		MidiTrack: "midi",
		AudioTrack: "audio",
		GroupTrack: "group",
		ReturnTrack: "return",
	};
	const tracks: Track[] = [];
	const addTrack = (t: XmlNode) => {
		const type = trackTypes[t.tag];
		if (!type) return;
		const m = find(t, "DeviceChain/Mixer");
		const seq = find(t, "DeviceChain/MainSequencer");
		tracks.push({
			id: t.attrs.Id ?? "",
			type,
			name: val(t, "Name/UserName") || val(t, "Name/EffectiveName") || t.tag,
			color: trackColor(t),
			muted: find(m, "Speaker/Manual") ? !bool(m, "Speaker/Manual", true) : false,
			groupId: val(t, "TrackGroupId") ?? "-1",
			devices: devicesOf(t),
			clips: collectClips(seq),
			volumeAutomation: hasVolumeAutomation(t, m),
		});
	};
	for (const t of child(set, "Tracks")?.children ?? []) addTrack(t);
	// возвратные дорожки в старых версиях лежат в <Tracks>, в новых тоже; на всякий случай добираем
	for (const t of child(set, "ReturnTracks")?.children ?? []) addTrack(t);

	let arrangementLength = 0;
	let sceneCount = 0;
	for (const t of tracks) {
		for (const c of t.clips) {
			if (c.where === "arrangement") arrangementLength = Math.max(arrangementLength, c.start + c.length);
			else sceneCount = Math.max(sceneCount, (c.scene ?? 0) + 1);
		}
	}
	return { file, creator, liveVersion, liveMajor, tempo, timeSignature, scale, locators, tracks, arrangementLength, sceneCount };
}

export function readProject(path: string): Project {
	const raw = readFileSync(path);
	const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8");
	return parseProject(text, path);
}
