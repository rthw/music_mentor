import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { analyzeProject } from "../lib/als/analysis.ts";
import { projectDiff } from "../lib/als/diff.ts";
import { findProjects, normalizeUserPath, projectRoots } from "../lib/als/files.ts";
import { clipNotesText, findClip, findTrack } from "../lib/als/notes.ts";
import { parseProject, readProject } from "../lib/als/parse.ts";
import { summarize } from "../lib/als/summary.ts";
import { parseXml } from "../lib/als/xml.ts";
import { buildAls, buildAlsXml } from "./alsbuild.ts";
import { midi } from "./helpers.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "als");

interface TrackExpect {
	type: string;
	name: string;
	devices: string[];
	muted: boolean;
	clips: number;
	notes: number;
}
interface FixtureExpect {
	creator: string;
	tempo: number;
	ts: [number, number];
	locators: number;
	scenes: number;
	arrangementBeats: number;
	tracks: TrackExpect[];
}

// Значения сверены с независимым разбором XML (python ElementTree: имена, число клипов и нот, Speaker, CurrentEnd).
const EXPECT: Record<string, FixtureExpect> = {
	"10/abletoolz_10_0_6.als": {
		creator: "Ableton Live 10.0.6", tempo: 172, ts: [4,4], locators: 0, scenes: 7, arrangementBeats: 512,
		tracks: [
			{ type: "group", name: "1-Group", devices: ["EQ Eight"], muted: false, clips: 0, notes: 0 },
			{ type: "midi", name: "2-Drum Rack", devices: ["Drum Rack","FabFilter Pro-Q (плагин)"], muted: false, clips: 8, notes: 503 },
			{ type: "audio", name: "3-Audio", devices: ["Gate"], muted: false, clips: 9, notes: 0 },
			{ type: "midi", name: "4-MicroTonicVST", devices: ["MicroTonicVST (плагин)","EQ Eight","Gate"], muted: true, clips: 0, notes: 0 },
			{ type: "audio", name: "5-Audio", devices: ["Fracture (плагин)"], muted: false, clips: 2, notes: 0 },
			{ type: "return", name: "A-FabFilter Timeless 2", devices: ["FabFilter Timeless 2 (плагин)"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Return", devices: [], muted: false, clips: 0, notes: 0 },
		],
	},
	"10/abletoolz_10_1_18.als": {
		creator: "Ableton Live 10.1.18", tempo: 127.204727, ts: [4,4], locators: 0, scenes: 12, arrangementBeats: 488.353,
		tracks: [
			{ type: "midi", name: "Rack", devices: ["Drum Rack"], muted: false, clips: 14, notes: 140 },
			{ type: "midi", name: "Snare", devices: ["3 5-MicroTonicVST (Freeze) [Drum Rack]"], muted: false, clips: 8, notes: 144 },
			{ type: "group", name: "5-Group", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "group", name: "16-Group", devices: ["Opto-Tight Compressor [Compressor]"], muted: true, clips: 0, notes: 0 },
			{ type: "audio", name: "20-Audio", devices: ["Crystallizer (плагин)","RatshackReverb2 x64 (плагин)","EchoBoy (плагин)","PhaseMistress (плагин)","EQ Eight","Compressor"], muted: true, clips: 3, notes: 0 },
			{ type: "audio", name: "21-Audio", devices: ["EQ Eight"], muted: true, clips: 4, notes: 0 },
			{ type: "return", name: "A-Pro-R", devices: ["Pro-R (плагин)"], muted: false, clips: 0, notes: 0 },
		],
	},
	"11/abletoolz_11_0_0.als": {
		creator: "Ableton Live 11.0", tempo: 171, ts: [4,4], locators: 0, scenes: 2, arrangementBeats: 860.016,
		tracks: [
			{ type: "group", name: "1-Group", devices: [], muted: true, clips: 0, notes: 0 },
			{ type: "audio", name: "2-Audio", devices: ["EQ Eight"], muted: false, clips: 3, notes: 0 },
			{ type: "audio", name: "3-Audio", devices: ["EQ Eight"], muted: true, clips: 2, notes: 0 },
			{ type: "group", name: "Drums", devices: ["EQ Eight","FabFilter Pro-C.64 (плагин)","Drum Buss"], muted: false, clips: 0, notes: 0 },
			{ type: "midi", name: "6-Maschine 2", devices: ["Maschine 2 (плагин)"], muted: true, clips: 0, notes: 0 },
			{ type: "midi", name: "Kick", devices: ["Instrument Rack","Reverb","Reverb","EQ Eight","Saturator","FabFilter Pro-C.64 (плагин)"], muted: false, clips: 47, notes: 219 },
			{ type: "return", name: "RTSCK", devices: ["Guitar Rig 5 (плагин)"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Guitar Rig 5 | EQ Eight", devices: ["Guitar Rig 5 (плагин)","EQ Eight"], muted: false, clips: 0, notes: 0 },
		],
	},
	"11/maxdevtools_test.als": {
		creator: "Ableton Live 11.3.13", tempo: 120, ts: [4,4], locators: 0, scenes: 0, arrangementBeats: 0,
		tracks: [
			{ type: "midi", name: "1-MIDI", devices: ["Max MIDI Effect"], muted: false, clips: 0, notes: 0 },
		],
	},
	"12/alsparse_midi.als": {
		creator: "Ableton Live 12.0.25", tempo: 130, ts: [4,4], locators: 0, scenes: 0, arrangementBeats: 132,
		tracks: [
			{ type: "midi", name: "1-808 Core Kit", devices: ["808 Core Kit [Drum Rack]"], muted: false, clips: 3, notes: 331 },
			{ type: "return", name: "A-Reverb", devices: ["Reverb"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Delay", devices: ["Simple Delay"], muted: false, clips: 0, notes: 0 },
		],
	},
	"12/groovebox_template_v12.als": {
		creator: "Ableton Live 12.2", tempo: 120, ts: [4,4], locators: 0, scenes: 0, arrangementBeats: 0,
		tracks: [
			{ type: "audio", name: "Drumbox", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "RetroBass", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "MiniMon", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "Poly-8", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "Horizon", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "A-Reverb", devices: ["Reverb"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Delay", devices: ["Simple Delay"], muted: false, clips: 0, notes: 0 },
		],
	},
	"12/live2midi_test.als": {
		creator: "Ableton Live 12.4.16", tempo: 120, ts: [4,4], locators: 0, scenes: 0, arrangementBeats: 44,
		tracks: [
			{ type: "midi", name: "Looped clips", devices: [], muted: false, clips: 4, notes: 16 },
			{ type: "midi", name: "Unlooped clips", devices: [], muted: false, clips: 6, notes: 21 },
		],
	},
	"12/vm_orchestral.als": {
		creator: "Ableton Live 12.4.16", tempo: 84, ts: [4,4], locators: 3, scenes: 3, arrangementBeats: 96,
		tracks: [
			{ type: "midi", name: "Strings", devices: ["Wavetable"], muted: false, clips: 6, notes: 144 },
			{ type: "midi", name: "Pad", devices: ["Drift"], muted: false, clips: 4, notes: 96 },
			{ type: "midi", name: "Bass", devices: ["Operator"], muted: false, clips: 4, notes: 64 },
			{ type: "midi", name: "Perc", devices: ["Drum Rack"], muted: false, clips: 2, notes: 96 },
			{ type: "audio", name: "5-Audio", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "6-Audio", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "A-Reverb", devices: ["Reverb"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Delay", devices: ["Simple Delay"], muted: false, clips: 0, notes: 0 },
		],
	},
	"12/vm_session_chords.als": {
		creator: "Ableton Live 12.4.15", tempo: 100, ts: [4,4], locators: 0, scenes: 2, arrangementBeats: 0,
		tracks: [
			{ type: "midi", name: "Chords", devices: ["Wavetable"], muted: false, clips: 2, notes: 36 },
			{ type: "midi", name: "Bass", devices: ["Operator"], muted: false, clips: 1, notes: 8 },
			{ type: "midi", name: "Melody", devices: ["Drift"], muted: false, clips: 1, notes: 12 },
			{ type: "audio", name: "4-Audio", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "audio", name: "5-Audio", devices: [], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "A-Reverb", devices: ["Reverb"], muted: false, clips: 0, notes: 0 },
			{ type: "return", name: "B-Delay", devices: ["Simple Delay"], muted: false, clips: 0, notes: 0 },
		],
	},
};

for (const [rel, exp] of Object.entries(EXPECT)) {
	test(`фикстура ${rel}: темп, размер, треки, устройства, клипы, ноты`, () => {
		const p = readProject(path.join(FIX, rel));
		assert.equal(p.creator, exp.creator);
		assert.equal(p.tempo, exp.tempo);
		assert.deepEqual(p.timeSignature, exp.ts);
		assert.equal(p.locators.length, exp.locators);
		assert.equal(p.sceneCount, exp.scenes);
		assert.equal(Math.round(p.arrangementLength * 1000) / 1000, exp.arrangementBeats);
		assert.equal(p.tracks.length, exp.tracks.length);
		exp.tracks.forEach((t, i) => {
			const got = p.tracks[i];
			assert.equal(got.type, t.type, `тип трека ${i + 1}`);
			assert.equal(got.name, t.name, `имя трека ${i + 1}`);
			assert.deepEqual(got.devices, t.devices, `устройства «${t.name}»`);
			assert.equal(got.muted, t.muted, `mute «${t.name}»`);
			assert.equal(got.clips.length, t.clips, `клипы «${t.name}»`);
			assert.equal(got.clips.reduce((a, c) => a + c.notes.length, 0), t.notes, `ноты «${t.name}»`);
		});
		// сводка читается и называет все треки
		const s = summarize(p);
		for (const t of exp.tracks) assert.ok(s.includes(`«${t.name}»`), `в сводке нет «${t.name}»`);
		assert.ok(s.includes(`${Math.round(exp.tempo * 100) / 100} BPM`));
	});
}

test("фикстура из VM (Live 12.4.16): локаторы, автоматизация громкости, Session и Arrangement", () => {
	const p = readProject(path.join(FIX, "12/vm_orchestral.als"));
	assert.deepEqual(p.locators, [{ time: 0, name: "Intro" }, { time: 32, name: "Theme" }, { time: 64, name: "Climax" }]);
	assert.deepEqual(p.tracks.filter((t) => t.volumeAutomation).map((t) => t.name), ["Strings"]);
	assert.equal(p.arrangementLength, 96);
	const strings = p.tracks[0];
	assert.deepEqual(strings.clips.filter((c) => c.where === "arrangement").map((c) => [c.name, c.start, c.length, c.notes.length]), [["Strings intro", 0, 32, 24], ["Strings theme", 32, 32, 24], ["Strings climax", 64, 32, 24]]);
	assert.deepEqual(strings.clips.filter((c) => c.where === "session").map((c) => [c.name, c.scene]), [["Strings intro", 0], ["Strings theme", 1], ["Strings climax", 2]]);
	const s = summarize(p);
	assert.match(s, /Локаторы: Intro \(т1\), Theme \(т9\), Climax \(т17\)/);
	assert.match(s, /«Strings» \(автоматизация громкости\)/);
	const an = analyzeProject(p);
	assert.match(an, /«Intro» т1–9: C мажор, звучит треков: 1/);
	assert.match(an, /«Climax» т17–25: D мажор, звучит треков: 4/);
	assert.match(an, /Энергия[^\n]*\[1 3 4\]/);
});

test("фикстура из VM: аккорды, бас и мелодия в Session", () => {
	const p = readProject(path.join(FIX, "12/vm_session_chords.als"));
	assert.equal(p.tempo, 100);
	assert.equal(p.arrangementLength, 0);
	const an = analyzeProject(p);
	assert.match(an, /Тональность \(Крумхансл\): C мажор/);
	assert.match(an, /Аккорды \(т1–8\): C \| G \| Am \| F \| C \| G\/B \| Am \| F\/A/);
	assert.match(an, /ступени: I \| V \| vi \| IV \| I \| V6 \| vi \| IV6/);
	assert.match(an, /Бас «Bass» против корней: корень 4[^\n]*бас на корнях/);
});

test("фикстуры: версии Live 10, 11 и 12 представлены", () => {
	const majors = new Set(Object.keys(EXPECT).map((k) => k.split("/")[0]));
	assert.deepEqual([...majors].sort(), ["10", "11", "12"]);
	for (const rel of Object.keys(EXPECT)) assert.equal(readProject(path.join(FIX, rel)).liveMajor, Number(rel.split("/")[0]));
});

test("project_summary на самой большой фикстуре ≤ 4 КБ", () => {
	let max = 0;
	for (const rel of Object.keys(EXPECT)) {
		const bytes = Buffer.byteLength(summarize(readProject(path.join(FIX, rel))), "utf8");
		max = Math.max(max, bytes);
		assert.ok(bytes <= 4096, `${rel}: ${bytes} байт`);
	}
	assert.ok(max > 1000, "сводка осмысленного размера");
	// самая большая по содержимому фикстура: 10.1.18 (14+8+… клипов)
	const big = summarize(readProject(path.join(FIX, "10/abletoolz_10_1_18.als")));
	assert.match(big, /127\.2 BPM, 4\/4/);
	assert.match(big, /Arrangement 122 тактов/);
	assert.match(big, /Drum Rack/);
});

test("clip_notes: ноты клипа, поиск трека и клипа по номеру и имени", () => {
	const p = readProject(path.join(FIX, "12/live2midi_test.als"));
	const t = findTrack(p, "Looped clips")!;
	assert.equal(t, findTrack(p, 1));
	const c = findClip(t, "2-bar loop")!;
	assert.equal(c.notes.length, 4);
	const txt = clipNotesText(p, t, c);
	assert.match(txt, /C4/);
	assert.equal(txt.split("\n").length, 2 + 4);
});

test("пути: Windows-стиль, ~, %VAR%", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-"));
	const sub = path.join(dir, "My Songs");
	mkdirSync(sub);
	assert.equal(normalizeUserPath(`${dir.replace(/\//g, "\\")}\\My Songs`, "/"), sub);
	assert.equal(normalizeUserPath("%MMDIR%/My Songs", "/", { MMDIR: dir }), sub);
	assert.equal(normalizeUserPath('"My Songs"', dir), sub);
	assert.match(normalizeUserPath("~/x"), /x$/);
});

test("project_list: Documents в OneDrive, пропуск Backup и Project Info, свежие сверху", () => {
	const home = mkdtempSync(path.join(tmpdir(), "mm-home-"));
	const docs = path.join(home, "OneDrive - Test", "Documents");
	mkdirSync(path.join(docs, "Live", "Song Project", "Backup"), { recursive: true });
	mkdirSync(path.join(docs, "Live", "Song Project", "Ableton Project Info"), { recursive: true });
	const als = buildAls({ tracks: [{ type: "midi", name: "A" }] });
	writeFileSync(path.join(docs, "Live", "Song Project", "Song.als"), als);
	writeFileSync(path.join(docs, "Live", "Song Project", "Backup", "Song [2026-01-01 000000].als"), als);
	writeFileSync(path.join(docs, "Live", "Song Project", "Ableton Project Info", "x.als"), als);
	const prev = process.env.HOME;
	const prevUp = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		const roots = projectRoots([], {});
		assert.ok(roots.some((r) => r.endsWith(path.join("OneDrive - Test", "Documents"))), roots.join(";"));
		const files = findProjects(roots);
		assert.deepEqual(files.map((f) => path.basename(f.path)), ["Song.als"]);
	} finally {
		process.env.HOME = prev;
		process.env.USERPROFILE = prevUp;
	}
});

test("XML-разбор: атрибуты, сущности, самозакрывающиеся теги, ошибки", () => {
	const n = parseXml('<?xml version="1.0"?><a x="1&amp;2"><b Value="Ы &lt;"/><c>text</c></a>');
	assert.equal(n.attrs.x, "1&2");
	assert.equal(n.children[0].attrs.Value, "Ы <");
	assert.equal(n.children[1].text, "text");
	assert.throws(() => parseXml("<a><b></a>"));
	assert.throws(() => parseProject("<NotAbleton/>"));
});

/* ---------- синтетический «оркестровый» проект ---------- */

const chordBars = (pitches: number[][], bar0: number, bpb = 4) => pitches.flatMap((cs, i) => cs.map((pitch) => ({ pitch, start: i * bpb, duration: bpb })));
const orchestral = () => {
	const secA = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]]; // C F G C
	const secB = [[50, 54, 57], [55, 59, 62], [57, 61, 64], [50, 54, 57]]; // D G A D
	const strings = [
		{ name: "Strings A", start: 0, length: 32, notes: chordBars([...secA, ...secA], 0).map((n) => ({ ...n, pitch: n.pitch + 12 })) },
		{ name: "Strings B", start: 64, length: 32, notes: chordBars([...secB, ...secB], 0).map((n) => ({ ...n, pitch: n.pitch + 12 })) },
	];
	const bass = [
		{ name: "Bass A", start: 32, length: 32, notes: [36, 41, 43, 36, 36, 41, 43, 36].map((pitch, i) => ({ pitch, start: i * 4, duration: 4 })) },
		{ name: "Bass B", start: 64, length: 32, notes: [38, 43, 45, 38, 38, 43, 45, 38].map((pitch, i) => ({ pitch, start: i * 4, duration: 4 })) },
	];
	return buildAls({
		tempo: 96,
		locators: [{ time: 0, name: "Вступление" }, { time: 32, name: "Тема" }, { time: 64, name: "Кульминация" }],
		tracks: [
			{ type: "midi", name: "Strings", devices: ["InstrumentVector"], volumeAutomation: true, clips: strings },
			{ type: "midi", name: "Pad", devices: ["InstrumentVector"], clips: [{ name: "Pad A", start: 32, length: 32, notes: chordBars([...secA, ...secA], 0) }, { name: "Pad B", start: 64, length: 32, notes: chordBars([...secB, ...secB], 0) }] },
			{ type: "midi", name: "Bass", devices: ["OriginalSimpler"], clips: bass },
			{ type: "midi", name: "Perc", devices: ["DrumGroupDevice"], clips: [{ name: "Beat", start: 64, length: 32, notes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ pitch: 36, start: i * 4, duration: 0.25, velocity: 60 + i * 5 })) }] },
		],
	});
};

test("оркестровый проект: локаторы, автоматизация громкости, имена устройств", () => {
	const p = parseProject(gunzipSync(orchestral()).toString(), "orch.als");
	assert.deepEqual(p.locators.map((l) => l.name), ["Вступление", "Тема", "Кульминация"]);
	assert.equal(p.tempo, 96);
	assert.equal(p.tracks[0].volumeAutomation, true);
	assert.equal(p.tracks[1].volumeAutomation, false);
	assert.deepEqual(p.tracks.map((t) => t.devices[0]), ["Wavetable", "Wavetable", "Simpler", "Drum Rack"]);
	assert.equal(p.arrangementLength, 96);
	const s = summarize(p);
	assert.match(s, /Локаторы: Вступление \(т1\), Тема \(т9\), Кульминация \(т17\)/);
	assert.match(s, /автоматизация громкости/);
});

test("project_analysis: тональность по секциям, аккорды, бас, энергия", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-orch-"));
	const f = path.join(dir, "orch.als");
	writeFileSync(f, orchestral());
	const text = analyzeProject(readProject(f));
	assert.match(text, /Тональность \(Крумхансл\): (C|D|G) мажор/);
	assert.match(text, /«Вступление» т1–9: C мажор, звучит треков: 1/);
	assert.match(text, /«Тема» т9–17: C мажор, звучит треков: 2/);
	assert.match(text, /«Кульминация» т17–25: D мажор, звучит треков: 4/);
	assert.match(text, /Аккорды «Тема», C мажор \(т9–[0-9]+\): C \| F \| G \| C×2 \| F \| G \| C/);
	assert.match(text, /ступени: I \| IV \| V \| I×2 \| IV \| V \| I/);
	assert.match(text, /Аккорды «Кульминация», D мажор \([^)]*\): D \| G \| A \| D×2 \| G \| A \| D/);
	assert.match(text, /Бас «Bass» против корней: корень \d+/);
	assert.match(text, /бас на корнях/);
	assert.match(text, /Энергия \(треков в 8-тактовых блоках\): \S+\s+\[1 2 4\]/);
	assert.match(text, /«Perc» \(ударные\)/);
});

/* ---------- project_diff ---------- */

test("project_diff: правка копии фикстуры (трек и клип) даёт ровно эти изменения", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-diff-"));
	const src = path.join(FIX, "12/live2midi_test.als");
	const copy = path.join(dir, "copy.als");
	writeFileSync(copy, readFileSync(src));
	// снимок до правки
	const first = projectDiff(readProject(copy), dir);
	assert.equal(first.first, true);
	assert.ok(readFileSync(path.join(dir, "learner", "snapshots", "copy.json"), "utf8").includes("Looped clips"));
	// без правок — «ничего не изменилось»
	const same = projectDiff(readProject(copy), dir);
	assert.equal(same.changes.length, 0);

	// правим XML копии: клонируем первый MidiTrack с новым Id и именем, без клипов, и кладём в него один клип
	let xml = gunzipSync(readFileSync(src)).toString("utf8");
	const trackStart = xml.indexOf("<MidiTrack ");
	const trackEnd = xml.indexOf("</MidiTrack>", trackStart) + "</MidiTrack>".length;
	let track = xml.slice(trackStart, trackEnd);
	const clipRe = /<MidiClip [\s\S]*?<\/MidiClip>/;
	const firstClip = clipRe.exec(track)![0];
	track = track.replace(/<MidiClip [\s\S]*?<\/MidiClip>/g, "");
	track = track.replace(/<MidiTrack Id="\d+"/, '<MidiTrack Id="99999"').replace(/<EffectiveName Value="[^"]*"/, '<EffectiveName Value="Подсказка: бас"').replace(/<UserName Value="[^"]*"/, '<UserName Value="Подсказка: бас"');
	const newClip = firstClip.replace(/Time="[^"]*"/, 'Time="8"').replace(/<CurrentStart Value="[^"]*"/, '<CurrentStart Value="8"').replace(/<CurrentEnd Value="[^"]*"/, '<CurrentEnd Value="12"').replace(/<Name Value="[^"]*"/, '<Name Value="Идея баса"');
	track = track.replace(/(<ClipTimeable>[\s\S]*?<Events)\s*\/>/, "$1></Events>").replace(/<\/Events>/, `${newClip}</Events>`);
	assert.ok(track.includes("Идея баса"), "клип вставлен в трек");
	xml = xml.slice(0, trackEnd) + track + xml.slice(trackEnd);
	writeFileSync(copy, gzipSync(Buffer.from(xml, "utf8")));

	const d = projectDiff(readProject(copy), dir);
	assert.equal(d.first, false);
	assert.deepEqual(d.changes.map((c) => c.kind), ["track_added", "clip_added"]);
	assert.match(d.changes[0].text, /новый трек «Подсказка: бас» \(midi\)/);
	assert.match(d.changes[1].text, /клип «Идея баса» \(Arrangement т3, 1т, 4 нот\) на «Подсказка: бас»/);
	// после сохранения нового снимка повторный diff пуст
	assert.equal(projectDiff(readProject(copy), dir).changes.length, 0);
});

test("project_diff: изменения нот, темпа, устройств, удаление, локаторы", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-diff2-"));
	const base = {
		tempo: 100,
		tracks: [
			{ type: "midi" as const, name: "Keys", id: 1, devices: ["InstrumentVector"], clips: [{ name: "A", start: 0, length: 4, notes: [{ pitch: 60, start: 0, duration: 1 }] }] },
			{ type: "midi" as const, name: "Lead", id: 2, clips: [{ name: "L", start: 0, length: 4, notes: [{ pitch: 72, start: 0, duration: 1 }] }] },
		],
	};
	const f = path.join(dir, "s.als");
	writeFileSync(f, buildAls(base));
	projectDiff(readProject(f), dir);
	const next = {
		tempo: 110,
		locators: [{ time: 16, name: "Припев" }],
		tracks: [
			{ ...base.tracks[0], devices: ["InstrumentVector", "Reverb"], clips: [{ name: "A", start: 0, length: 4, notes: [{ pitch: 60, start: 0, duration: 1 }, { pitch: 64, start: 1, duration: 1 }] }] },
		],
	};
	writeFileSync(f, buildAls(next));
	const d = projectDiff(readProject(f), dir);
	assert.deepEqual(d.changes.map((c) => c.kind).sort(), ["clip_changed", "device_added", "locator_added", "tempo", "track_removed"]);
	assert.match(d.text, /темп 100 → 110/);
	assert.match(d.text, /нот 1 → 2/);
	assert.match(d.text, /трек «Lead» удалён/);
});

/* ---------- расширение pi ---------- */

test("extensions/als.ts регистрирует пять инструментов и они работают на фикстуре 12", async () => {
	try {
		import.meta.resolve("typebox");
	} catch {
		// typebox ставит сам pi; в тестах без установки подменяем заглушкой
		registerHooks({
			resolve(specifier, context, next) {
				if (specifier === "typebox") return { url: new URL("./stubs/typebox.ts", import.meta.url).href, shortCircuit: true };
				return next(specifier, context);
			},
		});
	}
	const mod = await import("../extensions/als.ts");
	const tools = new Map<string, any>();
	mod.default({ registerTool: (t: any) => tools.set(t.name, t) } as any);
	assert.deepEqual([...tools.keys()].sort(), ["clip_notes", "project_analysis", "project_diff", "project_list", "project_summary"]);
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ext-"));
	const ctx = { cwd: dir };
	const file = path.join(FIX, "12/alsparse_midi.als");
	const sum = await tools.get("project_summary").execute("1", { path: file }, undefined, undefined, ctx);
	assert.match(sum.content[0].text, /130 BPM/);
	const notes = await tools.get("clip_notes").execute("2", { path: file, track: 1, clip: 1 }, undefined, undefined, ctx);
	assert.match(notes.content[0].text, /65 нот/);
	const an = await tools.get("project_analysis").execute("3", { path: file }, undefined, undefined, ctx);
	assert.match(an.content[0].text, /Анализ/);
	const d1 = await tools.get("project_diff").execute("4", { path: file }, undefined, undefined, ctx);
	assert.match(d1.content[0].text, /первый/);
	const d2 = await tools.get("project_diff").execute("5", { path: file }, undefined, undefined, ctx);
	assert.match(d2.content[0].text, /ничего не изменилось/);
	await assert.rejects(() => tools.get("project_summary").execute("6", { path: path.join(dir, "нет.als") }, undefined, undefined, ctx), /Не удалось прочитать/);
	void buildAlsXml;
	void midi;
});
