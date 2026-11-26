/**
 * Тренировка слуха: задания из материала ЕГО проекта — тональность, аккорды его последовательности,
 * его бас и его мелодия. Агент не слышит, но умеет играть: задание — это ноты клипа в Live.
 *
 * Задание = ноты для клипа + правильный ответ + варианты. Правильный ответ наружу отдаёт только
 * `ear_answer` (`extensions/ear.ts` держит его в состоянии сессии), поэтому модель до проверки не
 * может проболтаться.
 *
 * Здесь чистые функции: их проверяет tests/ear.test.ts, pi и Live для этого не нужны.
 * Уровни: 1 — широкие интервалы и два варианта, 2 — средние, 3 — узкие и четыре варианта.
 * Интервалы идут от широких к узким (октава/квинта/кварта → сексты/терции → секунды/септимы),
 * мелодический диктант растёт с 2 до 4 нот.
 */

import { isDrumTrack, trackNotes } from "../als/timeline.ts";
import type { Project } from "../als/parse.ts";
import { MODES, chordsByBar, detectKey, keyName, mod12, noteName, type Note } from "../music/index.ts";

export type EarKind = "interval" | "mode" | "degree" | "bass" | "dictation";
export type EarLevel = 1 | 2 | 3;

export const EAR_KINDS: EarKind[] = ["interval", "mode", "degree", "bass", "dictation"];

/** Название вида по-человечески: для «♪ Задание 3: мажор или минор…». */
export const KIND_TITLES: Record<EarKind, string> = {
	interval: "какой интервал",
	mode: "мажор или минор",
	degree: "ступень аккорда",
	bass: "какая нота баса изменилась",
	dictation: "диктант: сыграй ноты",
};

export const KIND_HINTS: Record<EarKind, string> = {
	interval: "Слушай две ноты подряд: первая — ниже, вторая — выше. Это не мелодия, а одна пара.",
	mode: "Звучит один аккорд целиком. Мажор кажется светлее, минор — темнее.",
	degree: "Звучит аккорд из твоей последовательности. Ступень — место корня в твоей тональности.",
	bass: "Два проигрывания подряд: сначала твоя басовая линия, потом она же с одной изменённой нотой.",
	dictation: "Звучит короткая фраза из твоего трека. Сыграй её на клавиатуре — проверим по нотам.",
};

/** Кварты/интервалы по уровням: от широких к узким. */
export const INTERVALS: Record<EarLevel, { semis: number; label: string }[]> = {
	1: [
		{ semis: 12, label: "октава" },
		{ semis: 7, label: "квинта" },
		{ semis: 5, label: "кварта" },
	],
	2: [
		{ semis: 9, label: "большая секста" },
		{ semis: 8, label: "малая секста" },
		{ semis: 4, label: "большая терция" },
		{ semis: 3, label: "малая терция" },
	],
	3: [
		{ semis: 2, label: "большая секунда" },
		{ semis: 1, label: "малая секунда" },
		{ semis: 11, label: "большая септима" },
		{ semis: 10, label: "малая септима" },
	],
};

/** Какие ступени спрашиваем: 1 — I и V, 2 — I, IV, V, 3 — I, IV, V, vi. */
export const DEGREES: Record<EarLevel, string[]> = {
	1: ["I", "V"],
	2: ["I", "IV", "V"],
	3: ["I", "IV", "V", "vi"],
};

/** Сколько нот в басовой линии и в диктанте. */
export const NOTE_COUNTS: Record<EarLevel, { bass: number; dictation: number }> = {
	1: { bass: 2, dictation: 2 },
	2: { bass: 3, dictation: 3 },
	3: { bass: 4, dictation: 4 },
};

export interface EarNote {
	pitch: number;
	start: number;
	duration: number;
	velocity?: number;
}

export interface EarChord {
	/** «Am7», «F» — как в анализе проекта. */
	name: string;
	/** Ступень с качеством: «V7», «vi», «IV». */
	degree: string;
	/** Только ступень: «V», «vi». */
	numeral: string;
	root: number;
	shape: "maj" | "min";
	pcs: number[];
}

export interface EarMaterial {
	key: { tonic: number; mode: string };
	keyName: string;
	/** Аккорды его последовательности (без повторов), либо трезвучия его тональности. */
	chords: EarChord[];
	/** Из чьего трека взяты аккорды и линии — чтобы сказать «это твой трек». */
	from: string;
	/** Одноголосная басовая линия (низшая нота в каждый момент). */
	bass: Note[];
	/** Одноголосная мелодическая линия (высшая нота в каждый момент). */
	melody: Note[];
	tempo: number;
	beatsPerBar: number;
}

export interface EarTask {
	kind: EarKind;
	level: EarLevel;
	/** Короткое название для тихой строки: «мажор или минор». */
	title: string;
	/** Вопрос ученику — без ответа. */
	question: string;
	/** Подсказка, как слушать (не раскрывает ответ). */
	hint: string;
	/** Варианты ответа; у диктанта пусто (ответ играют на клавиатуре). */
	options: string[];
	answer: string;
	answerKind: "choice" | "notes";
	/** Ноты клипа-задания. */
	notes: EarNote[];
	lengthBeats: number;
	/** Диктант: эталон, с которым сравниваем наигранное. */
	goalNotes?: EarNote[];
	/** Что сказать после ответа: почему так. */
	explanation: string;
	/** Откуда материал: «твоя тональность A минор», «аккорды из «Ночь.als»». */
	from: string;
}

export interface EarRequest {
	kind?: EarKind;
	level?: EarLevel;
	/** Что спрашивали последними: тот же вид подряд не даём, если есть из чего выбрать. */
	recent?: EarKind[];
	rng?: () => number;
}

const BASS_NAME = /bass|бас|sub|808/i;

/** Аккорды, которых в проекте нет (одноголосие): трезвучия его же тональности. */
const DIATONIC: { numeral: string; step: number; major: boolean }[] = [
	{ numeral: "I", step: 0, major: true },
	{ numeral: "IV", step: 5, major: true },
	{ numeral: "V", step: 7, major: true },
	{ numeral: "vi", step: 9, major: false },
];

function dedupe(notes: Note[]): Note[] {
	const seen = new Set<string>();
	const out: Note[] = [];
	for (const n of notes) {
		const k = `${n.pitch}|${n.start.toFixed(3)}|${n.duration.toFixed(3)}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(n);
	}
	return out;
}

function medianPitch(notes: Note[]): number {
	const s = notes.map((n) => n.pitch).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Одноголосная линия: в каждый момент начала берём одну ноту (низшую или высшую). */
export function monoLine(notes: Note[], edge: "low" | "high"): Note[] {
	const groups = new Map<number, Note[]>();
	for (const n of notes) {
		const k = Math.round(n.start * 1000);
		const list = groups.get(k);
		if (list) list.push(n);
		else groups.set(k, [n]);
	}
	const out: Note[] = [];
	for (const [, list] of [...groups].sort((a, b) => a[0] - b[0])) {
		out.push(list.reduce((a, b) => (edge === "low" ? (b.pitch < a.pitch ? b : a) : b.pitch > a.pitch ? b : a)));
	}
	return out;
}

/** Только ступень из «V7», «bVII», «iiø7», «I64». */
export function baseNumeral(degree: string): string {
	const m = /^([b#]?[ivIV]+)/.exec(degree ?? "");
	return m ? m[1] : degree ?? "";
}

function diatonicChords(key: { tonic: number; mode: string }): EarChord[] {
	const steps = MODES[key.mode] ?? MODES.major;
	return DIATONIC.map((d) => {
		// трезвучие по ступеням лада: качество получается само (в мажоре I/IV/V — мажор, vi — минор)
		const idx = steps.indexOf(d.step % 12);
		const third = idx >= 0 ? mod12(steps[(idx + 2) % 7] - steps[idx]) : 4;
		const shape: "maj" | "min" = third === 3 ? "min" : "maj";
		const root = mod12(key.tonic + d.step);
		return {
			name: noteName(root + 48, key.mode === "minor").replace(/\d$/, "") + (shape === "min" ? "m" : ""),
			degree: d.numeral,
			numeral: d.numeral,
			root,
			shape,
			pcs: [0, third, 7],
		};
	});
}

/** Материал для заданий из проекта: тональность, аккорды, бас и мелодия. null — нот нет. */
export function buildMaterial(p: Project): EarMaterial | null {
	const bpb = (p.timeSignature[0] * 4) / p.timeSignature[1];
	const tracks = p.tracks
		.map((t) => ({ name: t.name, notes: trackNotes(p, t), drum: isDrumTrack(t) }))
		.filter((x) => !x.drum && x.notes.length > 0);
	if (!tracks.length) return null;
	const all = dedupe(tracks.flatMap((x) => x.notes));
	const key = detectKey(all) ?? { tonic: mod12(all[0].pitch), mode: "major" as const };
	const keyObj = { tonic: key.tonic, mode: key.mode };
	const end = Math.max(...all.map((n) => n.start + n.duration), bpb);

	const segs = chordsByBar(all, { beatsPerBar: bpb, key: keyObj, range: { from: 0, to: Math.min(end, 32 * bpb) } });
	const chords: EarChord[] = [];
	const seenNames = new Set<string>();
	for (const seg of segs) {
		const c = seg.chord;
		if (!c || seenNames.has(c.name)) continue;
		seenNames.add(c.name);
		const shape: "maj" | "min" = /^min/.test(c.shape) ? "min" : "maj";
		chords.push({
			name: c.name,
			degree: c.degree ?? "",
			numeral: baseNumeral(c.degree ?? ""),
			root: c.root,
			shape,
			pcs: shape === "min" ? [0, 3, 7] : [0, 4, 7],
		});
		if (chords.length >= 6) break;
	}
	const harmonic = chords.length ? chords : diatonicChords(keyObj);

	const bassTrack = tracks.find((x) => BASS_NAME.test(x.name)) ?? (tracks.length > 1 ? tracks.reduce((a, b) => (medianPitch(b.notes) < medianPitch(a.notes) ? b : a)) : undefined);
	const melodyTrack = tracks.filter((x) => x !== bassTrack).sort((a, b) => medianPitch(b.notes) - medianPitch(a.notes))[0];

	const bass = monoLine(bassTrack ? bassTrack.notes : all.filter((n) => n.pitch < 48), "low");
	const melody = monoLine(melodyTrack ? melodyTrack.notes : all.filter((n) => n.pitch >= 48), "high");

	return {
		key: keyObj,
		keyName: keyName(keyObj.tonic, keyObj.mode),
		chords: harmonic,
		from: p.file.split(/[\\/]/).pop() ?? "",
		bass,
		melody: melody.length ? melody : bass,
		tempo: p.tempo,
		beatsPerBar: bpb,
	};
}

/** Какие виды заданий можно собрать из этого материала. */
export function availableKinds(m: EarMaterial): EarKind[] {
	const out: EarKind[] = ["interval", "mode"];
	if (m.chords.length >= 2) out.push("degree");
	if (new Set(m.bass.map((n) => n.pitch)).size >= 2) out.push("bass");
	if (m.melody.length >= NOTE_COUNTS[3].dictation) out.push("dictation");
	return out;
}

const pick = <T>(list: T[], rng: () => number): T => list[Math.floor(rng() * list.length) % list.length];

function shuffle<T>(list: T[], rng: () => number): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1)) % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Ноты аккорда в среднем регистре: корень в C3–B3, квинта и секста выше. */
function chordPitches(chord: EarChord, bassOctave = false): number[] {
	const root = 48 + mod12(chord.root);
	const out = chord.pcs.map((pc) => root + pc);
	if (bassOctave) out.unshift(root - 12);
	return out;
}

function flatten(pitches: number[], start: number, duration: number, velocity = 90): EarNote[] {
	return pitches.map((pitch) => ({ pitch, start, duration, velocity }));
}

function noteNames(notes: EarNote[], flats: boolean): string {
	return notes.map((n) => noteName(n.pitch, flats)).join(" ");
}

function intervalTask(m: EarMaterial, level: EarLevel, rng: () => number): EarTask {
	const set = INTERVALS[level];
	const chosen = pick(set, rng);
	const base = 48 + mod12(m.key.tonic); // от тоники его тональности, C3–B3
	const lower = base;
	const upper = base + chosen.semis;
	const options = shuffle(
		set.map((x) => x.label),
		rng,
	);
	const flats = m.key.mode === "minor" || m.key.mode === "phrygian" || m.key.mode === "dorian";
	return {
		kind: "interval",
		level,
		title: KIND_TITLES.interval,
		question: `Какой интервал между двумя нотами? Варианты: ${options.join(", ")}.`,
		hint: KIND_HINTS.interval,
		options,
		answer: chosen.label,
		answerKind: "choice",
		notes: [...flatten([lower], 0, 1), ...flatten([upper], 1, 1)],
		lengthBeats: 3,
		explanation: `${chosen.label}: ${noteName(lower, flats)} → ${noteName(upper, flats)} (${chosen.semis} полутонов), от тоники твоей тональности ${m.keyName}.`,
		from: `тональность «${m.from}» — ${m.keyName}`,
	};
}

function modeTask(m: EarMaterial, level: EarLevel, rng: () => number): EarTask {
	// аккорд из его последовательности, если он там есть; иначе — на тонике его тональности
	const fromKey = m.chords.filter((c) => mod12(c.root - m.key.tonic) === 0);
	const source = fromKey.length && rng() < 0.5 ? pick(fromKey, rng) : m.chords.length ? pick(m.chords, rng) : undefined;
	let root: number;
	let shape: "maj" | "min";
	if (source) {
		root = source.root;
		shape = source.shape;
	} else {
		root = m.key.tonic;
		shape = rng() < 0.5 ? "maj" : "min";
	}
	const chord: EarChord = { name: "", degree: "", numeral: "", root, shape, pcs: shape === "min" ? [0, 3, 7] : [0, 4, 7] };
	const pitches = chordPitches(chord, level >= 2);
	const spread = level >= 3 ? [...pitches, pitches[0] + 24] : pitches;
	const answer = shape === "min" ? "минор" : "мажор";
	const flats = shape === "min";
	return {
		kind: "mode",
		level,
		title: KIND_TITLES.mode,
		question: "Этот аккорд мажорный или минорный?",
		hint: KIND_HINTS.mode,
		options: shuffle(["мажор", "минор"], rng),
		answer,
		answerKind: "choice",
		notes: flatten(spread, 0, 4),
		lengthBeats: 4,
		explanation: `${answer}${shape === "min" ? " (малая терция: 3 полутона от корня)" : " (большая терция: 4 полутона от корня)"}: ${noteName(root + 48, flats)}${shape === "min" ? "m" : ""}.`,
		from: source && source.name ? `аккорд из «${m.from}»: ${source.name}` : `тональность «${m.from}» — ${m.keyName}`,
	};
}

function degreeTask(m: EarMaterial, level: EarLevel, rng: () => number): EarTask {
	const wanted = DEGREES[level];
	const maxOptions = level === 1 ? 2 : level === 2 ? 3 : 4;
	const present = m.chords.filter((c) => wanted.includes(c.numeral));
	const pool = present.length >= 2 ? present : m.chords;
	const chord = pick(pool, rng);
	// варианты — ступени из ЕГО последовательности, сначала те, что положены уровню
	const rank = (n: string) => (wanted.includes(n) ? 0 : 1);
	const others = [...new Set(m.chords.map((c) => c.numeral))]
		.filter((n) => n !== chord.numeral)
		.sort((a, b) => rank(a) - rank(b));
	const options = shuffle([chord.numeral, ...others.slice(0, maxOptions - 1)], rng);
	return {
		kind: "degree",
		level,
		title: KIND_TITLES.degree,
		question: `Какая это ступень в твоей тональности ${m.keyName}? Варианты: ${options.join(", ")}.`,
		hint: KIND_HINTS.degree,
		options,
		answer: chord.numeral,
		answerKind: "choice",
		notes: flatten(chordPitches(chord, true), 0, 4),
		lengthBeats: 4,
		explanation: `Это ${chord.numeral} — ${chord.name}${chord.degree && chord.degree !== chord.numeral ? ` (${chord.degree})` : ""} в ${m.keyName}.`,
		from: `аккорды «${m.from}»: ${m.chords.map((c) => c.name).join(" ")}`,
	};
}

function bassTask(m: EarMaterial, level: EarLevel, rng: () => number): EarTask {
	const count = NOTE_COUNTS[level].bass;
	// разные по высоте ноты его баса: вопрос «которая нота» не должен иметь двух одинаковых ответов
	const distinct: Note[] = [];
	for (const n of m.bass) {
		if (distinct.length >= count) break;
		if (distinct.some((x) => x.pitch === n.pitch)) continue;
		distinct.push(n);
	}
	const flats = m.key.mode === "minor";
	const base = distinct.map((n, i) => ({ pitch: n.pitch, start: i, duration: 0.9, velocity: 90 }));
	const changedAt = Math.floor(rng() * base.length) % base.length;
	const step = rng() < 0.5 ? 1 : -1;
	const original = base[changedAt].pitch;
	let replacement = original + step;
	if (base.some((n) => n.pitch === replacement)) replacement = original - step;
	const changed = base.map((n, i) => (i === changedAt ? { ...n, pitch: replacement } : { ...n }));
	// два проигрывания подряд: твоя линия, потом она же с одной другой нотой
	const notes: EarNote[] = [...base, ...changed.map((n) => ({ ...n, start: n.start + base.length + 1 }))];
	const options = shuffle(base.map((n) => noteName(n.pitch, flats)), rng);
	return {
		kind: "bass",
		level,
		title: KIND_TITLES.bass,
		question: `Во втором проигрывании одна нота твоего баса звучит иначе. Которая? Варианты: ${options.join(", ")}.`,
		hint: KIND_HINTS.bass,
		options,
		answer: noteName(original, flats),
		answerKind: "choice",
		notes,
		lengthBeats: base.length * 2 + 2,
		explanation: `${changedAt + 1}-я нота: была ${noteName(original, flats)}, стала ${noteName(replacement, flats)}.`,
		from: `бас из «${m.from}»`,
	};
}

function dictationTask(m: EarMaterial, level: EarLevel, rng: () => number): EarTask {
	const count = NOTE_COUNTS[level].dictation;
	const line = m.melody.length >= count ? m.melody : m.bass;
	const maxStart = Math.max(0, line.length - count);
	const from = Math.floor(rng() * (maxStart + 1)) % (maxStart + 1);
	const run = line.slice(from, from + count);
	// сдвигаем фразу в удобный для клавиатуры регистр целыми октавами
	const low = Math.min(...run.map((n) => n.pitch));
	const shift = low < 48 ? 12 * Math.ceil((48 - low) / 12) : low > 72 ? -12 * Math.ceil((low - 72) / 12) : 0;
	const goalNotes: EarNote[] = run.map((n, i) => ({ pitch: n.pitch + shift, start: i, duration: 1, velocity: 90 }));
	const flats = m.key.mode === "minor";
	return {
		kind: "dictation",
		level,
		title: KIND_TITLES.dictation,
		question: `${count === 2 ? "Две ноты" : count === 3 ? "Три ноты" : "Четыре ноты"} из твоего трека, по одной доле. Сыграй их на клавиатуре и скажи, когда готово.`,
		hint: KIND_HINTS.dictation,
		options: [],
		answer: noteNames(goalNotes, flats),
		answerKind: "notes",
		notes: goalNotes.map((n) => ({ ...n })),
		lengthBeats: count + 1,
		goalNotes,
		explanation: `Фраза из «${m.from}»: ${noteNames(goalNotes, flats)}.`,
		from: `мелодия «${m.from}»`,
	};
}

const BUILDERS: Record<EarKind, (m: EarMaterial, level: EarLevel, rng: () => number) => EarTask> = {
	interval: intervalTask,
	mode: modeTask,
	degree: degreeTask,
	bass: bassTask,
	dictation: dictationTask,
};

/** Собрать задание. Недоступный вид (нет баса, нет аккордов) заменяется другим из этого материала. */
export function makeTask(m: EarMaterial, req: EarRequest = {}): EarTask {
	const rng = req.rng ?? Math.random;
	const level = req.level ?? 1;
	const available = availableKinds(m);
	let kind = req.kind && available.includes(req.kind) ? req.kind : undefined;
	if (!kind) {
		const fresh = available.filter((k) => !(req.recent ?? []).includes(k));
		kind = pick(fresh.length ? fresh : available, rng);
	}
	const task = BUILDERS[kind](m, level, rng);
	// варианты обязаны содержать правильный ответ; у диктанта вариантов нет
	if (task.answerKind === "choice" && !task.options.includes(task.answer)) task.options = shuffle([...task.options, task.answer], rng);
	return task;
}

/** Строка «♪ Задание 3: мажор или минор» — для тихого экрана. */
export function taskLine(task: EarTask, number: number): string {
	return `♪ Задание ${number}: ${task.title}`;
}

/** Ответ ученика к сравнимому виду: регистр, «ё», пунктуация, «мажорный» → «мажор», «4» → «IV». */
export function normalizeAnswer(s: string): string {
	const digits: Record<string, string> = { "1": "i", "2": "ii", "3": "iii", "4": "iv", "5": "v", "6": "vi", "7": "vii" };
	return String(s ?? "")
		.toLowerCase()
		.replace(/ё/g, "е")
		.replace(/мажорн\p{L}*/gu, "мажор")
		.replace(/минорн\p{L}*/gu, "минор")
		.replace(/\b([1-7])\b/g, (_, d: string) => digits[d])
		.replace(/[^a-zа-яёivx0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Проверка ответа-варианта. «Верно», если ответ совпал с правильным; принимаем и вхождение
 * («кажется, это квинта»), но тогда засчитываем именно найденный вариант.
 */
export function gradeChoice(given: string, task: EarTask): { right: boolean; matched?: string } {
	const g = normalizeAnswer(given);
	const answer = normalizeAnswer(task.answer);
	if (!g) return { right: false };
	if (g === answer) return { right: true, matched: task.answer };
	for (const option of task.options) {
		const o = normalizeAnswer(option);
		if (!o) continue;
		if (g === o || g.includes(o) || o.includes(g)) return { right: o === answer, matched: option };
	}
	return { right: false };
}

/**
 * Ноты варианта ответа: после ошибки нужно услышать оба варианта рядом — свой и правильный.
 * Возвращает null, когда варианта в нотах нет: у баса оба проигрывания уже в клипе, у диктанта
 * сравнивать нечего (эталон — объяснение после проверки).
 */
export function optionNotes(m: EarMaterial, task: EarTask, option: string): { notes: EarNote[]; lengthBeats: number; label: string } | null {
	const want = normalizeAnswer(option);
	if (!want) return null;
	if (task.kind === "interval") {
		for (const level of [1, 2, 3] as EarLevel[]) {
			const found = INTERVALS[level].find((x) => normalizeAnswer(x.label) === want || normalizeAnswer(x.label).includes(want));
			if (!found) continue;
			const lower = 48 + mod12(m.key.tonic);
			return { notes: [...flatten([lower], 0, 1), ...flatten([lower + found.semis], 1, 1)], lengthBeats: 3, label: found.label };
		}
		return null;
	}
	if (task.kind === "mode") {
		const minor = want.includes("минор");
		const major = want.includes("мажор");
		if (!minor && !major) return null;
		const lowest = Math.min(...task.notes.map((n) => n.pitch));
		const root = lowest + (task.level >= 2 ? 12 : 0);
		const pcs = minor ? [0, 3, 7] : [0, 4, 7];
		const pitches = pcs.map((pc) => root + pc);
		const spread = task.level >= 3 ? [...pitches, root + 24] : task.level >= 2 ? [root - 12, ...pitches] : pitches;
		return { notes: flatten(spread, 0, 4), lengthBeats: 4, label: minor ? "минор" : "мажор" };
	}
	if (task.kind === "degree") {
		const chord = m.chords.find((c) => normalizeAnswer(c.numeral) === want);
		if (!chord) return null;
		return { notes: flatten(chordPitches(chord, true), 0, 4), lengthBeats: 4, label: chord.numeral };
	}
	return null;
}
