/**
 * Сравнение того, что ученик сыграл руками, с целью: где ноты верные, где пропуск, где лишняя,
 * где не та высота, насколько рано или поздно он играет и ровно ли.
 *
 * Живая игра — не квантованные ноты: допуск по времени (по умолчанию 1/16 доли) и общий сдвиг
 * всей записи (начал на долю позже — это одна история, а не ошибка каждой ноты).
 * Время — в долях (четвертных), мс — по темпу проекта. Показ — такт.доля.
 *
 * Здесь чистые функции: их проверяет tests/compare.test.ts, pi для этого не нужен.
 */

import { barBeat } from "../als/format.ts";
import { noteName } from "../music/pitch.ts";

export interface PlayNote {
	pitch: number;
	start: number;
	duration?: number;
	velocity?: number;
}

export interface CompareOptions {
	/** Темп проекта, BPM: нужен только для мс. По умолчанию 120. */
	tempo?: number;
	/** Доля в такте для «такт.доля». По умолчанию 4. */
	beatsPerBar?: number;
	/** Допуск по времени в долях. По умолчанию 1/16 = 0.25. */
	tolerance?: number;
	/** Наибольший общий сдвиг записи, который ищем, в долях. По умолчанию 2. */
	maxShift?: number;
}

/** Учтённая нота: нота цели и её сыгранная пара. */
export interface MatchedNote {
	goal: PlayNote;
	played: PlayNote;
	/** Сыграл раньше (−) или позже (+) на столько долей, уже без общего сдвига. */
	offsetBeats: number;
	offsetMs: number;
}

export interface PitchError {
	goal: PlayNote;
	played: PlayNote;
	/** На сколько полутонов разошлось: +1 = взял на полтона выше. */
	semitones: number;
	kind: "полтона" | "октава" | "другое";
	offsetBeats: number;
	offsetMs: number;
}

export interface ChordReport {
	/** Начало аккорда в долях от начала клипа. */
	at: number;
	/** Высоты цели. */
	pitches: number[];
	/** Сколько нот аккорда взято (верная высота или не та). */
	taken: number;
	complete: boolean;
	/** Разнобой внутри аккорда: самый поздний минус самый ранний, мс. */
	spreadMs: number;
	spreadBeats: number;
}

export interface TimingReport {
	meanBeats: number;
	meanMs: number;
	/** Разброс опозданий (среднеквадратичное), мс: это ровность. */
	spreadMs: number;
	spreadBeats: number;
	earliestMs: number;
	latestMs: number;
	/** Самая ранняя и самая поздняя ноты — чтобы сказать конкретно. */
	earliest?: MatchedNote;
	latest?: MatchedNote;
}

export interface VelocityReport {
	mean: number;
	/** Разброс velocity (среднеквадратичное). */
	sd: number;
	min: number;
	max: number;
	/** Среднее velocity в цели (если в цели оно есть). */
	goalMean?: number;
}

export interface CompareResult {
	goalCount: number;
	playedCount: number;
	/** Ноты, взятые верно по высоте и в допуске. */
	correct: MatchedNote[];
	missing: PlayNote[];
	extra: PlayNote[];
	wrongPitch: PitchError[];
	timing: TimingReport;
	/** Общий сдвиг всей записи в долях: + значит играл позже. */
	shift: { beats: number; ms: number };
	chords: { groups: ChordReport[]; complete: number; total: number; meanSpreadMs: number; worst?: ChordReport };
	velocity?: VelocityReport;
	tolerance: { beats: number; ms: number };
	/** Совсем без расхождений (по высотам и по допуску). */
	perfect: boolean;
	tempo: number;
	beatsPerBar: number;
}

const EPS = 1e-6;
const DEFAULT_TOLERANCE = 0.25; // 1/16
const DEFAULT_MAX_SHIFT = 2;

const beatsToMs = (beats: number, tempo: number) => (beats * 60_000) / (tempo || 120);

const sd = (xs: number[]) => {
	if (xs.length < 2) return 0;
	const m = xs.reduce((a, b) => a + b, 0) / xs.length;
	return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

interface MatchPair {
	gi: number;
	pi: number;
	offset: number;
}

/** Жадное сопоставление по одинаковой высоте: каждая нота цели — к ближайшей свободной сыгранной. */
function matchSamePitch(goal: PlayNote[], played: PlayNote[], shift: number, tol: number): { pairs: MatchPair[]; usedPlayed: boolean[] } {
	const usedPlayed = new Array<boolean>(played.length).fill(false);
	const pairs: MatchPair[] = [];
	const order = goal.map((_, i) => i).sort((a, b) => goal[a].start - goal[b].start || goal[a].pitch - goal[b].pitch);
	for (const gi of order) {
		const g = goal[gi];
		let best = -1;
		let bestAbs = Number.POSITIVE_INFINITY;
		for (let pi = 0; pi < played.length; pi++) {
			if (usedPlayed[pi] || played[pi].pitch !== g.pitch) continue;
			const offset = played[pi].start - shift - g.start;
			const abs = Math.abs(offset);
			if (abs <= tol + EPS && abs < bestAbs) {
				best = pi;
				bestAbs = abs;
			}
		}
		if (best >= 0) {
			usedPlayed[best] = true;
			pairs.push({ gi, pi: best, offset: played[best].start - shift - goal[gi].start });
		}
	}
	return { pairs, usedPlayed };
}

/**
 * Общий сдвиг записи: ищем, при каком сдвиге совпадает больше всего нот. Мелкий сдвиг (меньше
 * половины допуска) не считаем — это просто живое время, оно видно по каждой ноте.
 */
export function detectShift(goal: PlayNote[], played: PlayNote[], tol: number, maxShift: number): number {
	if (!goal.length || !played.length) return 0;
	const base = matchSamePitch(goal, played, 0, tol).pairs.length;
	const seen = new Set<number>();
	let best = 0;
	let bestScore = base;
	for (const g of goal) {
		for (const p of played) {
			const cand = round(p.start - g.start, 3);
			if (Math.abs(cand) > maxShift || Math.abs(cand) < tol / 2 || seen.has(cand)) continue;
			seen.add(cand);
			const score = matchSamePitch(goal, played, cand, tol).pairs.length;
			if (score > bestScore || (score === bestScore && score > base && Math.abs(cand) < Math.abs(best))) {
				best = cand;
				bestScore = score;
			}
		}
	}
	return bestScore > base ? best : 0;
}

/** Сравнить цель с сыгранным. */
export function comparePlay(goalNotes: PlayNote[], playedNotes: PlayNote[], opts: CompareOptions = {}): CompareResult {
	const tempo = opts.tempo && opts.tempo > 0 ? opts.tempo : 120;
	const beatsPerBar = opts.beatsPerBar && opts.beatsPerBar > 0 ? opts.beatsPerBar : 4;
	const tol = opts.tolerance && opts.tolerance > 0 ? opts.tolerance : DEFAULT_TOLERANCE;
	const maxShift = opts.maxShift && opts.maxShift >= 0 ? opts.maxShift : DEFAULT_MAX_SHIFT;
	const goal = [...goalNotes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
	const played = [...playedNotes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

	const shiftBeats = detectShift(goal, played, tol, maxShift);
	const { pairs, usedPlayed } = matchSamePitch(goal, played, shiftBeats, tol);
	const usedGoal = new Set(pairs.map((p) => p.gi));
	const matchOf = new Map<number, MatchPair>(pairs.map((p) => [p.gi, p]));

	const correct: MatchedNote[] = pairs.map(({ gi, pi, offset }) => ({
		goal: goal[gi],
		played: played[pi],
		offsetBeats: round(offset),
		offsetMs: Math.round(beatsToMs(offset, tempo)),
	}));
	// Не та высота: нота цели совпала по времени, но высота другая — полтона и октава отдельно.
	const wrongPitch: PitchError[] = [];
	for (let gi = 0; gi < goal.length; gi++) {
		if (usedGoal.has(gi)) continue;
		const g = goal[gi];
		let best = -1;
		let bestAbs = Number.POSITIVE_INFINITY;
		for (let pi = 0; pi < played.length; pi++) {
			if (usedPlayed[pi]) continue;
			const abs = Math.abs(played[pi].start - shiftBeats - g.start);
			if (abs <= tol + EPS && abs < bestAbs) {
				best = pi;
				bestAbs = abs;
			}
		}
		if (best < 0) continue;
		usedPlayed[best] = true;
		usedGoal.add(gi);
		const semitones = played[best].pitch - g.pitch;
		const kind = Math.abs(semitones) === 1 ? "полтона" : Math.abs(semitones) === 12 ? "октава" : "другое";
		const offset = played[best].start - shiftBeats - g.start;
		wrongPitch.push({
			goal: g,
			played: played[best],
			semitones,
			kind,
			offsetBeats: round(offset),
			offsetMs: Math.round(beatsToMs(offset, tempo)),
		});
	}

	const missing = goal.filter((_, gi) => !usedGoal.has(gi));
	const extra = played.filter((_, pi) => !usedPlayed[pi]);

	// Время: средняя ошибка, разброс (ровность), крайние ноты.
	const offsets = correct.map((c) => c.offsetBeats);
	const meanBeats = mean(offsets);
	const timing: TimingReport = {
		meanBeats: round(meanBeats),
		meanMs: Math.round(beatsToMs(meanBeats, tempo)),
		spreadMs: Math.round(beatsToMs(sd(offsets), tempo)),
		spreadBeats: round(sd(offsets)),
		earliestMs: correct.length ? Math.min(...correct.map((c) => c.offsetMs)) : 0,
		latestMs: correct.length ? Math.max(...correct.map((c) => c.offsetMs)) : 0,
	};
	for (const c of correct) {
		if (c.offsetMs === timing.earliestMs && (!timing.earliest || c.offsetMs < timing.earliest.offsetMs)) timing.earliest = c;
		if (c.offsetMs === timing.latestMs) timing.latest = c;
	}

	// Аккорды: ноты цели с почти одинаковым началом.
	const win = Math.max(tol / 2, 0.05);
	const clusters: number[][] = [];
	for (let gi = 0; gi < goal.length; gi++) {
		const last = clusters[clusters.length - 1];
		if (last && Math.abs(goal[last[0]].start - goal[gi].start) <= win) last.push(gi);
		else clusters.push([gi]);
	}
	const groups: ChordReport[] = [];
	for (const cluster of clusters) {
		if (cluster.length < 2) continue;
		const takenOffsets: number[] = [];
		let taken = 0;
		for (const gi of cluster) {
			const same = matchOf.get(gi);
			if (same) {
				taken++;
				takenOffsets.push(same.offset);
				continue;
			}
			const wrong = wrongPitch.findIndex((w) => w.goal === goal[gi]);
			if (wrong >= 0) {
				taken++;
				takenOffsets.push(wrongPitch[wrong].offsetBeats);
			}
		}
		const spreadBeats = takenOffsets.length > 1 ? Math.max(...takenOffsets) - Math.min(...takenOffsets) : 0;
		groups.push({
			at: goal[cluster[0]].start,
			pitches: cluster.map((gi) => goal[gi].pitch),
			taken,
			complete: taken === cluster.length,
			spreadMs: Math.round(beatsToMs(spreadBeats, tempo)),
			spreadBeats: round(spreadBeats),
		});
	}
	const completeGroups = groups.filter((g) => g.complete);
	const worst = groups.length ? groups.reduce((a, b) => (b.spreadMs > a.spreadMs ? b : a)) : undefined;
	const chords = {
		groups,
		complete: completeGroups.length,
		total: groups.length,
		meanSpreadMs: Math.round(mean(groups.map((g) => g.spreadMs))),
		worst,
	};

	// Velocity: ровность сыгранного (и насколько отличается от цели).
	const playedUsed = [...correct.map((c) => c.played), ...wrongPitch.map((w) => w.played)].filter((n) => typeof n.velocity === "number");
	let velocity: VelocityReport | undefined;
	if (playedUsed.length) {
		const vs = playedUsed.map((n) => Number(n.velocity));
		const goalVs = goal.filter((n) => typeof n.velocity === "number").map((n) => Number(n.velocity));
		velocity = {
			mean: Math.round(mean(vs)),
			sd: Math.round(sd(vs)),
			min: Math.min(...vs),
			max: Math.max(...vs),
			...(goalVs.length ? { goalMean: Math.round(mean(goalVs)) } : {}),
		};
	}

	return {
		goalCount: goal.length,
		playedCount: played.length,
		correct,
		missing,
		extra,
		wrongPitch,
		timing,
		shift: { beats: round(shiftBeats), ms: Math.round(beatsToMs(shiftBeats, tempo)) },
		chords,
		velocity,
		tolerance: { beats: round(tol), ms: Math.round(beatsToMs(tol, tempo)) },
		perfect: !missing.length && !extra.length && !wrongPitch.length,
		tempo,
		beatsPerBar,
	};
}

/** Одна строка итога для свёрнутого экрана: «14 из 16 нот, в среднем опаздываешь на 40 мс». */
export function compareVerdict(r: CompareResult): string {
	if (!r.goalCount && !r.playedCount) return "нот нет";
	const parts = [`${r.correct.length} из ${pluralN(r.goalCount, "ноты", "нот")}`];
	if (r.shift.beats) parts.push(`вся запись сдвинута на ${fmtBeats(r.shift.beats)}`);
	const m = r.timing.meanMs;
	if (r.correct.length > 1) {
		if (Math.abs(m) < 15) parts.push("в среднем ровно");
		else parts.push(`в среднем ${m > 0 ? "опаздываешь" : "спешишь"} на ${Math.abs(m)} мс`);
	}
	return parts.join(", ");
}

/** Русское слово для числа: «4 нот» читается плохо, поэтому «4 ноты» / «14 нот». */
export function pluralN(n: number, few: string, many: string): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
	return `${n} ${many}`;
}

function fmtBeats(b: number): string {
	const s = Math.abs(b) < 1e-9 ? "0" : String(Math.round(b * 1000) / 1000).replace(".", ",");
	return `${b > 0 ? "+" : b < 0 ? "−" : ""}${s} ${pluralDoli(Math.abs(b))}`;
}

function pluralDoli(abs: number): string {
	if (Math.abs(abs - 1) < 1e-9) return "долю";
	const mod10 = Math.round(abs) % 10;
	const mod100 = Math.round(abs) % 100;
	return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "доли" : "долей";
}

function rating(spreadMs: number): string {
	if (spreadMs <= 20) return "ровно";
	if (spreadMs <= 45) return "почти ровно";
	if (spreadMs <= 90) return "неровно";
	return "совсем неровно";
}

/**
 * Текст для модели: 3–6 строк итога и таблица расхождений (если они есть).
 * Велик ли вывод — решает вызывающий: строки при ошибках ограничены.
 */
export function compareText(r: CompareResult, opts: { maxRows?: number; maxNotes?: number } = {}): string {
	const bpb = r.beatsPerBar;
	const pos = (beats: number) => barBeat(beats, bpb);
	const maxRows = opts.maxRows ?? 12;
	const maxNotes = opts.maxNotes ?? 6;
	const lines: string[] = [];

	const wrongCount = r.wrongPitch.length;
	const head = [`${r.correct.length} из ${r.goalCount} нот верно`];
	if (wrongCount) head.push(`${wrongCount} не та высота`);
	if (r.missing.length) head.push(`${r.missing.length} пропущено`);
	if (r.extra.length) head.push(`${r.extra.length} лишних`);
	lines.push((r.perfect ? "✓ " : "• ") + head.join(", "));

	if (r.shift.beats) {
		lines.push(`Вся запись сдвинута на ${fmtBeats(r.shift.beats)} (${Math.abs(r.shift.ms)} мс): играл ${r.shift.beats > 0 ? "позже" : "раньше"} целиком. Это не ошибка каждой ноты — сдвиг учтён, ниже времена уже без него.`);
	}

	if (r.correct.length) {
		const m = r.timing.meanMs;
		const where = m > 15 ? "опаздываешь" : m < -15 ? "спешишь" : "ровно по времени";
		lines.push(
			`Время: ${where}${Math.abs(m) > 15 ? ` в среднем на ${Math.abs(m)} мс (${Math.abs(r.timing.meanBeats)} доли)` : " (в среднем 0 мс)"}, разброс ±${r.timing.spreadMs} мс — ${rating(r.timing.spreadMs)}; крайние ${r.timing.earliestMs} и ${r.timing.latestMs} мс.`,
		);
	}

	if (r.chords.total) {
		const c = r.chords;
		let s = `Аккорды: ${c.complete} из ${c.total} взяты полностью`;
		if (c.meanSpreadMs) s += `, разнобой внутри аккорда в среднем ${c.meanSpreadMs} мс`;
		if (c.worst && c.worst.spreadMs > 0) s += `, худший — ${pos(c.worst.at)} (${c.worst.spreadMs} мс)`;
		const incomplete = c.groups.filter((g) => !g.complete);
		if (incomplete.length) s += `; неполные: ${incomplete.slice(0, 4).map((g) => pos(g.at)).join(", ")}`;
		lines.push(s + ".");
	}

	if (r.velocity) {
		const v = r.velocity;
		const same = v.goalMean !== undefined && Math.abs(v.mean - v.goalMean) <= 8;
		let s = `Velocity: ${v.min}–${v.max}, среднее ${v.mean}, разброс ±${v.sd} — ${v.sd <= 8 ? "ровно" : v.sd <= 18 ? "почти ровно" : "неровно"}`;
		if (v.goalMean !== undefined) s += same ? `, как в цели (${v.goalMean})` : `, в цели ${v.goalMean}`;
		lines.push(s + ".");
	}

	lines.push(`Допуск по времени ${r.tolerance.beats} доли = ${r.tolerance.ms} мс при ${Math.round(r.tempo)} BPM: в него попал — не ошибка, живое опоздание 10–20 мс норма.`);

	const rows: string[] = [];
	for (const w of r.wrongPitch) {
		const dir = Math.abs(w.semitones) === 1 ? "полтона" : Math.abs(w.semitones) === 12 ? "октава" : `${w.semitones > 0 ? "+" : ""}${w.semitones} полутонов`;
		rows.push([pos(w.goal.start), `${noteName(w.goal.pitch)} → ${noteName(w.played.pitch)}`, `${dir} ${w.semitones > 0 ? "выше" : "ниже"}`, `${w.offsetMs > 0 ? "+" : ""}${w.offsetMs} мс`].join("\t"));
	}
	for (const m of r.missing) rows.push([pos(m.start), noteName(m.pitch), "пропуск", "—"].join("\t"));
	for (const e of r.extra) rows.push([pos(e.start), "—", `лишняя ${noteName(e.pitch)}`, "—"].join("\t"));

	const outliers = [...r.correct]
		.sort((a, b) => Math.abs(b.offsetMs) - Math.abs(a.offsetMs))
		.filter((c) => Math.abs(c.offsetMs) > 40)
		.slice(0, Math.max(0, maxNotes - rows.length));
	for (const c of outliers) rows.push([pos(c.goal.start), noteName(c.played.pitch), c.offsetMs > 0 ? "опоздал" : "поторопился", `${c.offsetMs > 0 ? "+" : ""}${c.offsetMs} мс`].join("\t"));

	if (rows.length) {
		lines.push("");
		lines.push("такт.доля  нота  что  время");
		lines.push(...rows.slice(0, maxRows));
		if (rows.length > maxRows) lines.push(`…ещё ${rows.length - maxRows}`);
	}
	return lines.join("\n");
}
