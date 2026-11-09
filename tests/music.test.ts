import { test } from "node:test";
import assert from "node:assert/strict";
import { blockChords, line, midi } from "./helpers.ts";
import { bassVsRoots, chordsByBar, detectKey, detectMode, outOfKey, parallelPerfects, progressionString, rhythmReport, energyByBlock, energyCurve, guessInstrument, rangeReport, muddyIntervals, detectChord, keyByWindows } from "../lib/music/index.ts";

const names = (notes: ReturnType<typeof blockChords>, key: { tonic: number; mode: string }) => chordsByBar(notes, { key }).map((s) => s.chord?.name ?? "-");
const degrees = (notes: ReturnType<typeof blockChords>, key: { tonic: number; mode: string }) => chordsByBar(notes, { key }).map((s) => s.chord?.degree ?? "-");

test("I–V–vi–IV в C: тональность, аккорды, ступени", () => {
	const bars = [
		["C2", "C4", "E4", "G4"],
		["G2", "B3", "D4", "G4"],
		["A2", "C4", "E4", "A4"],
		["F2", "C4", "F4", "A4"],
	];
	const notes = blockChords([...bars, ...bars]);
	const key = detectKey(notes)!;
	assert.equal(key.name, "C мажор");
	const k = { tonic: key.tonic, mode: key.mode };
	assert.deepEqual(names(notes, k), ["C", "G", "Am", "F", "C", "G", "Am", "F"]);
	assert.deepEqual(degrees(notes, k), ["I", "V", "vi", "IV", "I", "V", "vi", "IV"]);
	assert.equal(progressionString(chordsByBar(notes, { key: k })), "C | G | Am | F | C | G | Am | F");
});

test("ii–V–I в F: септаккорды и ступени", () => {
	const notes = blockChords([
		["G2", "D4", "F4", "Bb4"], // Gm7 без квинты в верху, с квинтой в басу не нужен: G D F Bb
		["C2", "E4", "G4", "Bb4"], // C7
		["F2", "A3", "C4", "E4"], // Fmaj7
		["F2", "A3", "C4", "E4"],
	]);
	const key = detectKey(notes)!;
	assert.equal(key.name, "F мажор");
	const k = { tonic: key.tonic, mode: key.mode };
	const segs = chordsByBar(notes, { key: k });
	assert.deepEqual(segs.map((s) => s.chord?.name), ["Gm7", "C7", "Fmaj7", "Fmaj7"]);
	assert.deepEqual(segs.map((s) => s.chord?.degree), ["ii7", "V7", "Imaj7", "Imaj7"]);
});

test("минор с гармонической V: тональность Am, E7 с G#, G# не считается чужой нотой", () => {
	const notes = blockChords([
		["A2", "A3", "C4", "E4"],
		["D3", "A3", "D4", "F4"],
		["E2", "B3", "E4", "G#4"],
		["A2", "A3", "C4", "E4"],
		["F2", "A3", "C4", "F4"],
		["E2", "B3", "D4", "G#4"],
		["A2", "A3", "C4", "E4"],
		["A2", "A3", "C4", "E4"],
	]);
	const key = detectKey(notes)!;
	assert.equal(key.name, "A минор");
	const k = { tonic: key.tonic, mode: key.mode };
	const segs = chordsByBar(notes, { key: k });
	assert.equal(segs[2].chord?.name, "E");
	assert.equal(segs[5].chord?.name, "E7");
	assert.equal(segs[5].chord?.degree, "V7");
	assert.equal(segs[0].chord?.degree, "i");
	const out = outOfKey(notes, k);
	assert.equal(out.count, 0);
	assert.ok(out.raisedMinor >= 2);
});

test("модальная дорийская: D дорийский, а не C мажор", () => {
	// Dm7 – G (IV мажорное, ключевая нота B) на педали D
	const mel = line([
		["D4", 0, 2], ["F4", 2, 1], ["E4", 3, 1],
		["G4", 4, 2], ["B4", 6, 1], ["A4", 7, 1],
		["D4", 8, 2], ["F4", 10, 1], ["E4", 11, 1],
		["G4", 12, 2], ["A4", 14, 1], ["C5", 15, 1],
	]);
	const bass = line([["D2", 0, 8], ["D2", 8, 8]]);
	const mode = detectMode([...mel, ...bass])!;
	assert.equal(mode.mode, "dorian");
	assert.equal(mode.name, "D dorian");
	assert.equal(mode.coverage, 1);
	const chords = chordsByBar([...mel, ...line([["D3", 0, 4], ["F3", 0, 4], ["A3", 0, 4], ["G2", 4, 4], ["B2", 4, 4], ["D3", 4, 4]])], { range: { from: 0, to: 8 } });
	assert.equal(chords[0].chord?.name, "Dm");
	assert.equal(chords[1].chord?.name, "G");
});

test("хроматизм: bVII и вторичная доминанта, чужие ноты считаются", () => {
	const notes = blockChords([
		["C2", "C4", "E4", "G4"],
		["A2", "C#4", "E4", "G4"], // A7 (V7/ii)
		["D2", "D4", "F4", "A4"],
		["G2", "D4", "F4", "B4"], // G7 — слов "D F B G"
		["Bb2", "Bb3", "D4", "F4"], // bVII
		["F2", "A3", "C4", "F4"],
		["C2", "E4", "G4", "C5"],
		["C2", "E4", "G4", "C5"],
	]);
	const key = detectKey(notes)!;
	assert.equal(key.name, "C мажор");
	const k = { tonic: key.tonic, mode: key.mode };
	const segs = chordsByBar(notes, { key: k });
	assert.deepEqual(segs.map((s) => s.chord?.name), ["C", "A7", "Dm", "G7", "Bb", "F", "C", "C"]);
	assert.equal(segs[4].chord?.degree, "bVII");
	assert.equal(segs[1].chord?.degree, "VI7");
	const out = outOfKey(notes, k);
	assert.equal(out.count, 3); // чужие ноты по числу нот: C# (A7) и Bb (Bb-аккорд: бас и терция)
	assert.deepEqual(out.byPc.map((x) => x.pc).sort(), [1, 10]);
});

test("обращения и sus", () => {
	const c1 = detectChord(blockChords([["E3", "G3", "C4"]]), { from: 0, to: 4 })!;
	assert.equal(c1.name, "C/E");
	assert.equal(c1.inversion, 1);
	const c2 = detectChord(blockChords([["G2", "C4", "E4", "G4"]]), { from: 0, to: 4 })!;
	assert.equal(c2.name, "C/G");
	assert.equal(c2.inversion, 2);
	const s = detectChord(blockChords([["C3", "F4", "G4"]]), { from: 0, to: 4 })!;
	assert.equal(s.shape, "sus4");
	assert.equal(s.name, "Csus4");
	const two = detectChord(blockChords([["C4", "G4"]]), { from: 0, to: 4 });
	assert.equal(two, null);
});

test("такт делится на доли, если аккорды меняются внутри", () => {
	const notes = blockChords([["C3", "E4", "G4"]], { beatsPerBar: 2 }).concat(
		blockChords([["F3", "A4", "C5"]], { beatsPerBar: 2 }).map((n) => ({ ...n, start: n.start + 2 })),
	);
	const segs = chordsByBar(notes);
	assert.deepEqual(segs.map((s) => [s.bar, s.beat, s.chord?.name]), [[1, 1, "C"], [1, 3, "F"]]);
});

test("тональность по окнам тактов", () => {
	const a = blockChords([["C3", "E4", "G4"], ["F3", "A3", "C4"], ["G3", "B3", "D4"], ["C3", "E4", "G4"]]);
	const b = blockChords([["D3", "F#4", "A4"], ["G3", "B3", "D4"], ["A3", "C#4", "E4"], ["D3", "F#4", "A4"]]).map((n) => ({ ...n, start: n.start + 16 }));
	const wins = keyByWindows([...a, ...b], [{ from: 0, to: 16 }, { from: 16, to: 32 }]);
	assert.equal(wins[0]!.name, "C мажор");
	assert.equal(wins[1]!.name, "D мажор");
});

test("бас против корней", () => {
	const notes = blockChords([["C4", "E4", "G4"], ["G3", "B3", "D4"], ["A3", "C4", "E4"], ["F3", "A3", "C4"]]);
	const segs = chordsByBar(notes);
	const rootsBass = line([["C2", 0, 4], ["G2", 4, 4], ["A2", 8, 4], ["F2", 12, 4]]);
	assert.equal(bassVsRoots(rootsBass, segs).movesBeyondRoots, false);
	const movingBass = line([["E2", 0, 4], ["D2", 4, 4], ["C3", 8, 4], ["A2", 12, 4]]);
	const rep = bassVsRoots(movingBass, segs);
	assert.equal(rep.third, 3); // E в C, C в Am, A в F
	assert.equal(rep.fifth, 1); // D в G
	assert.equal(rep.movesBeyondRoots, true);
});

test("параллельные квинты и октавы крайних голосов", () => {
	// верх: C5-D5-E5, низ: F3-G3-A3 -> интервалы 5-ты вниз?  C5-F3 = 31 (квинта + 2 окт), D5-G3 тоже
	const fifths = line([["F3", 0, 1], ["C5", 0, 1], ["G3", 1, 1], ["D5", 1, 1]]);
	const p = parallelPerfects(fifths);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "fifths");
	const oct = line([["C3", 0, 1], ["C4", 0, 1], ["D3", 1, 1], ["D4", 1, 1]]);
	assert.equal(parallelPerfects(oct)[0].kind, "octaves");
	// противоположное движение, те же квинты — не параллель
	const contrary = line([["C3", 0, 1], ["G3", 0, 1], ["B2", 1, 1], ["F#3", 1, 1]]);
	// оба вниз => параллель; а для контрарного: низ вниз, верх вверх
	const none = line([["C3", 0, 1], ["G3", 0, 1], ["B2", 1, 1], ["A3", 1, 1]]);
	assert.equal(parallelPerfects(none).length, 0);
	assert.equal(parallelPerfects(contrary).length, 1);
});

test("ритм: сетка, синкопы, velocity", () => {
	const straight = [0, 1, 2, 3, 4, 5, 6, 7].map((t, i) => ({ pitch: 60, start: t * 0.5, duration: 0.25, velocity: 100 }));
	const r = rhythmReport(straight);
	assert.equal(r.grid, 0.5);
	assert.equal(r.gridName, "1/8");
	assert.equal(r.velocity.spread, 0);
	assert.equal(r.syncopation, 0);
	// 4 восьмых «и» без следующей доли — синкопа
	const sync = [0.5, 2.5].map((s) => ({ pitch: 60, start: s, duration: 1, velocity: 80 }));
	assert.equal(rhythmReport(sync).syncopation, 1);
	const human = [0, 1.03, 2.11, 2.9].map((s, i) => ({ pitch: 60, start: s, duration: 0.5, velocity: 60 + i * 20 }));
	const h = rhythmReport(human);
	assert.equal(h.grid, null);
	assert.equal(h.velocity.spread, 60);
	const dense = rhythmReport(Array.from({ length: 16 }, (_, i) => ({ pitch: 60, start: i * 0.25, duration: 0.25, velocity: 100 })));
	assert.equal(dense.grid, 0.25);
	assert.equal(dense.density, 16);
});

test("диапазон и грязные интервалы в низу", () => {
	assert.equal(guessInstrument("Cello solo")?.id, "cello");
	assert.equal(guessInstrument("Double Bass")?.id, "double_bass");
	assert.equal(guessInstrument("Sub Bass")?.id, "synth_bass");
	const inst = guessInstrument("Flute")!;
	const rep = rangeReport(line([["B3", 0, 1], ["C6", 1, 1], ["C8", 2, 1]]), inst)!;
	assert.equal(rep.above, 1);
	assert.equal(rep.below, 1);
	assert.equal(rep.lowest, "B3");
	assert.equal(rep.highest, "C8");
	// терция E1+G#1 — грязно; квинта C2+G2 — чисто; терция выше E3 — нормально
	const dirty = muddyIntervals(line([["C2", 0, 2], ["E2", 0, 2], ["C2", 4, 2], ["G2", 4, 2], ["C4", 8, 2], ["E4", 8, 2]]));
	assert.equal(dirty.length, 1);
	assert.deepEqual([dirty[0].low, dirty[0].high], ["C2", "E2"]);
});

test("энергия: число треков в 8-тактовых блоках", () => {
	const tracks = [
		{ name: "pad", spans: [{ start: 0, end: 64 }] },
		{ name: "bass", spans: [{ start: 32, end: 64 }] },
		{ name: "perc", spans: [{ start: 32, end: 48 }] },
	];
	const blocks = energyByBlock(tracks);
	assert.deepEqual(blocks.map((b) => b.active), [1, 3]);
	assert.deepEqual(blocks[1].names, ["pad", "bass", "perc"]);
	assert.equal(blocks.length, 2);
	assert.ok(energyCurve(blocks).length === 2);
});

test("midi() разбирает имена нот", () => {
	assert.equal(midi("C4"), 60);
	assert.equal(midi("A0"), 21);
});
