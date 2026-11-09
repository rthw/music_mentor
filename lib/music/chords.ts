/**
 * Аккорды по тактам и долям: трезвучия, септаккорды, sus, обращения, ступень в тональности.
 * Шаблоны сопоставляются с весами классов высот окна; бас (низшая нота) определяет обращение.
 */

import { scaleOf } from "./key.ts";
import { mod12, pcName, prefersFlats, weightIn, type Note, type Window } from "./pitch.ts";

export interface ChordShape {
	id: string;
	/** Интервалы от корня. */
	pcs: number[];
	/** Суффикс в названии: "", "m", "7", "maj7"… */
	suffix: string;
	/** Базовый вес шаблона: септаккорды и редкие структуры чуть дороже, чтобы не вылезали зря. */
	cost: number;
}

export const SHAPES: ChordShape[] = [
	{ id: "maj", pcs: [0, 4, 7], suffix: "", cost: 0 },
	{ id: "min", pcs: [0, 3, 7], suffix: "m", cost: 0 },
	{ id: "dim", pcs: [0, 3, 6], suffix: "dim", cost: 0.04 },
	{ id: "aug", pcs: [0, 4, 8], suffix: "aug", cost: 0.06 },
	{ id: "sus4", pcs: [0, 5, 7], suffix: "sus4", cost: 0.04 },
	{ id: "sus2", pcs: [0, 2, 7], suffix: "sus2", cost: 0.04 },
	{ id: "dom7", pcs: [0, 4, 7, 10], suffix: "7", cost: 0.03 },
	{ id: "maj7", pcs: [0, 4, 7, 11], suffix: "maj7", cost: 0.03 },
	{ id: "min7", pcs: [0, 3, 7, 10], suffix: "m7", cost: 0.03 },
	{ id: "hdim7", pcs: [0, 3, 6, 10], suffix: "m7b5", cost: 0.04 },
	{ id: "dim7", pcs: [0, 3, 6, 9], suffix: "dim7", cost: 0.04 },
	{ id: "minmaj7", pcs: [0, 3, 7, 11], suffix: "m(maj7)", cost: 0.08 },
	{ id: "dom7sus4", pcs: [0, 5, 7, 10], suffix: "7sus4", cost: 0.06 },
];

export interface Chord {
	root: number;
	shape: string;
	/** Название, например "Am7" или "C/E". */
	name: string;
	bass: number;
	/** 0 — основной вид, 1 — первое обращение и т.д. (по басу в составе аккорда). */
	inversion: number;
	/** Доля веса окна, пришедшаяся на ноты аккорда, 0…1. */
	fit: number;
	/** Римская ступень в тональности, если тональность передана: "V7", "ii", "bVII". */
	degree?: string;
}

export interface ChordSegment {
	/** Номер такта с 1. */
	bar: number;
	/** Доля в такте с 1. */
	beat: number;
	from: number;
	to: number;
	chord: Chord | null;
}

function shapeSuffix(shape: ChordShape): string {
	return shape.suffix;
}

/** Определить аккорд в окне. null — если звучит меньше трёх разных классов высот или посадка слабая. */
export function detectChord(notes: Note[], window: Window, opts: { key?: { tonic: number; mode: string }; minFit?: number } = {}): Chord | null {
	const weights = new Array<number>(12).fill(0);
	let lowest: { pitch: number; w: number } | null = null;
	let total = 0;
	for (const n of notes) {
		const w = weightIn(n, window);
		if (w <= 0) continue;
		weights[mod12(n.pitch)] += w;
		total += w;
		if (!lowest || n.pitch < lowest.pitch || (n.pitch === lowest.pitch && w > lowest.w)) lowest = { pitch: n.pitch, w };
	}
	if (total === 0 || !lowest) return null;
	const present = weights.filter((x) => x > total * 0.04).length;
	if (present < 3) return null; // двух звуков мало для аккорда: не выдумываем
	const bassPc = mod12(lowest.pitch);
	let best: { root: number; shape: ChordShape; score: number; fit: number } | null = null;
	for (let root = 0; root < 12; root++) {
		for (const shape of SHAPES) {
			const set = new Set(shape.pcs.map((p) => mod12(root + p)));
			let inside = 0;
			let missing = 0;
			for (const pc of set) {
				if (weights[pc] > 0) inside += weights[pc];
				else missing++;
			}
			// у трезвучия обязательны корень и терция/секунда/кварта: нет корня — не аккорд
			if (weights[root] === 0) continue;
			const fit = inside / total;
			// обязательные тоны: корень и характерная нота; на септаккорде допускаем пропуск квинты
			const needed = shape.pcs.filter((p) => p !== 7 || shape.pcs.length === 3);
			const missingNeeded = needed.filter((p) => weights[mod12(root + p)] === 0).length;
			if (missingNeeded > 0) continue;
			const score = fit - shape.cost - missing * 0.03 + (bassPc === root ? 0.04 : 0) + (weights[root] / total) * 0.05;
			if (!best || score > best.score) best = { root, shape, score, fit };
		}
	}
	if (!best || best.fit < (opts.minFit ?? 0.7)) return null;
	const set = best.shape.pcs.map((p) => mod12(best.root + p));
	const inversion = Math.max(0, set.indexOf(bassPc));
	const flats = opts.key
		? scaleOf(opts.key.tonic, opts.key.mode).has(best.root)
			? prefersFlats(opts.key.tonic, opts.key.mode)
			: [1, 3, 8, 10].includes(best.root) || prefersFlats(opts.key.tonic, opts.key.mode) // чужой корень: bII, bIII, bVI, bVII
		: prefersFlats(best.root, best.shape.id.startsWith("min") ? "minor" : "major");
	let name = pcName(best.root, flats) + shapeSuffix(best.shape);
	if (set.includes(bassPc) && bassPc !== best.root) name += `/${pcName(bassPc, flats)}`;
	const chord: Chord = { root: best.root, shape: best.shape.id, name, bass: bassPc, inversion, fit: best.fit };
	if (opts.key) chord.degree = romanDegree(chord, opts.key.tonic, opts.key.mode);
	return chord;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
// ступень по полутонам от тоники: [индекс римской цифры, бемоль/диез]
const MAJOR_DEG: [number, string][] = [[0, ""], [1, "b"], [1, ""], [2, "b"], [2, ""], [3, ""], [3, "#"], [4, ""], [5, "b"], [5, ""], [6, "b"], [6, ""]];
const MINOR_DEG: [number, string][] = [[0, ""], [1, "b"], [1, ""], [2, ""], [2, "#"], [3, ""], [4, "b"], [4, ""], [5, ""], [5, "#"], [6, ""], [6, "#"]];

export function romanDegree(chord: Chord, tonic: number, mode: string): string {
	const interval = mod12(chord.root - tonic);
	const minorish = mode === "minor" || mode === "dorian" || mode === "phrygian" || mode === "locrian";
	const [idx, acc] = (minorish ? MINOR_DEG : MAJOR_DEG)[interval];
	const lowerShapes = new Set(["min", "dim", "hdim7", "dim7", "min7", "minmaj7"]);
	let numeral = ROMAN[idx];
	if (lowerShapes.has(chord.shape)) numeral = numeral.toLowerCase();
	let suffix = "";
	switch (chord.shape) {
		case "dim": suffix = "°"; break;
		case "aug": suffix = "+"; break;
		case "dom7": suffix = "7"; break;
		case "maj7": suffix = "maj7"; break;
		case "min7": suffix = "7"; break;
		case "hdim7": suffix = "ø7"; break;
		case "dim7": suffix = "°7"; break;
		case "minmaj7": suffix = "(maj7)"; break;
		case "sus4": suffix = "sus4"; break;
		case "sus2": suffix = "sus2"; break;
		case "dom7sus4": suffix = "7sus4"; break;
	}
	const seventh = ["dom7", "maj7", "min7", "hdim7", "dim7", "minmaj7", "dom7sus4"].includes(chord.shape);
	let figure = "";
	if (chord.inversion === 1) figure = seventh ? "65" : "6";
	else if (chord.inversion === 2) figure = seventh ? "43" : "64";
	else if (chord.inversion === 3) figure = "42";
	// фигурный бас заменяет «7»
	const base = suffix === "7" && figure ? "" : suffix;
	return `${acc}${numeral}${base}${figure}`;
}

export interface ChordOptions {
	beatsPerBar?: number;
	key?: { tonic: number; mode: string };
	/** Окно анализа в долях; по умолчанию от нуля до конца нот. */
	range?: Window;
	/** Если одного аккорда на такт не хватает (fit ниже порога) — дробить на половины, потом доли. */
	split?: boolean;
	splitThreshold?: number;
}

/** Аккорды по тактам; при необходимости такт делится на половины и доли. Подряд одинаковые не склеиваются. */
export function chordsByBar(notes: Note[], opts: ChordOptions = {}): ChordSegment[] {
	const bpb = opts.beatsPerBar ?? 4;
	const end = opts.range?.to ?? Math.max(0, ...notes.map((n) => n.start + n.duration));
	const begin = opts.range?.from ?? 0;
	const threshold = opts.splitThreshold ?? 0.85;
	const out: ChordSegment[] = [];
	const firstBar = Math.floor(begin / bpb);
	const lastBar = Math.ceil(end / bpb);
	const detect = (from: number, to: number) => detectChord(notes, { from, to }, { key: opts.key, minFit: 0.6 });
	const seg = (barIdx: number, from: number, to: number, chord: Chord | null) =>
		out.push({ bar: barIdx + 1, beat: Math.round((from - barIdx * bpb) * 100) / 100 + 1, from, to, chord });
	for (let b = firstBar; b < lastBar; b++) {
		const from = b * bpb;
		const to = from + bpb;
		const whole = detect(from, to);
		if (opts.split === false || (whole && whole.fit >= threshold)) {
			seg(b, from, to, whole);
			continue;
		}
		// пробуем половины
		const parts: [number, number][] = [];
		if (bpb % 2 === 0) {
			const mid = from + bpb / 2;
			parts.push([from, mid], [mid, to]);
		} else {
			for (let i = 0; i < bpb; i++) parts.push([from + i, from + i + 1]);
		}
		const halves = parts.map(([f, t]) => ({ f, t, c: detect(f, t) }));
		const halvesGood = halves.every((h) => h.c && h.c.fit >= threshold);
		const wholeFit = whole?.fit ?? 0;
		if (halvesGood && (!whole || halves.some((h) => h.c!.name !== halves[0].c!.name))) {
			for (const h of halves) seg(b, h.f, h.t, h.c);
			continue;
		}
		if (!whole || wholeFit < 0.7) {
			// доли
			const beats: { f: number; t: number; c: Chord | null }[] = [];
			for (let i = 0; i < bpb; i++) beats.push({ f: from + i, t: from + i + 1, c: detect(from + i, from + i + 1) });
			const merged: typeof beats = [];
			for (const x of beats) {
				const prev = merged[merged.length - 1];
				if (prev && prev.c && x.c && prev.c.name === x.c.name) prev.t = x.t;
				else merged.push({ ...x });
			}
			if (merged.filter((m) => m.c).length > 0 && merged.length > 1) {
				for (const m of merged) seg(b, m.f, m.t, m.c);
				continue;
			}
		}
		seg(b, from, to, whole);
	}
	return out;
}

/** Строка «C | Am | F | G7» для отчёта; повтор подряд сворачивается в «×N». */
export function progressionString(segments: ChordSegment[], useDegrees = false): string {
	const labels = segments.map((s) => (s.chord ? ((useDegrees ? s.chord.degree : undefined) ?? s.chord.name) : "—"));
	const out: string[] = [];
	for (let i = 0; i < labels.length; ) {
		let j = i;
		while (j + 1 < labels.length && labels[j + 1] === labels[i]) j++;
		out.push(j > i ? `${labels[i]}×${j - i + 1}` : labels[i]);
		i = j + 1;
	}
	return out.join(" | ");
}
