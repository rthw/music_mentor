/** Ритм: плотность, сетка квантования, синкопы, разброс velocity. */

import type { Note } from "./pitch.ts";

export interface RhythmReport {
	notes: number;
	bars: number;
	/** Нот на такт. */
	density: number;
	/** Самая крупная сетка (в долях), на которую ложатся ≥ 95% стартов; null — нет такой (играно «от руки»). */
	grid: number | null;
	gridName: string;
	/** Доля стартов вне сетки 1/16. */
	offGridRatio: number;
	/** Доля нот-синкоп. */
	syncopation: number;
	velocity: { min: number; max: number; mean: number; stdev: number; spread: number };
}

// сетки от крупной к мелкой: четверть, восьмая, триоль восьмых, шестнадцатая, триоль 16-х, тридцать вторая
export const GRIDS: { beats: number; name: string }[] = [
	{ beats: 1, name: "1/4" },
	{ beats: 0.5, name: "1/8" },
	{ beats: 1 / 3, name: "1/8 триоль" },
	{ beats: 0.25, name: "1/16" },
	{ beats: 1 / 6, name: "1/16 триоль" },
	{ beats: 0.125, name: "1/32" },
];

function onGrid(t: number, step: number, tol: number): boolean {
	const r = t / step;
	return Math.abs(r - Math.round(r)) * step <= tol;
}

export function detectGrid(starts: number[], tol = 0.02): { beats: number; name: string } | null {
	if (!starts.length) return null;
	for (const g of GRIDS) {
		const fit = starts.filter((t) => onGrid(t, g.beats, tol)).length / starts.length;
		if (fit >= 0.95) return g;
	}
	return null;
}

/**
 * Синкопа: нота начинается не на доле и следующая доля не начинается новой нотой
 * (её «перекрывает» длящаяся нота или пауза). Берём только ноты с началом на «и» и подобных позициях.
 */
export function syncopation(notes: Note[], tol = 0.02): number {
	if (!notes.length) return 0;
	const starts = notes.map((n) => n.start);
	let synced = 0;
	for (const n of notes) {
		const frac = n.start - Math.floor(n.start + tol);
		if (Math.abs(frac) <= tol || Math.abs(frac - 1) <= tol) continue; // на доле
		const nextBeat = Math.floor(n.start) + 1;
		const attackOnNext = starts.some((s) => Math.abs(s - nextBeat) <= tol);
		if (!attackOnNext && n.start + n.duration > nextBeat - tol) synced++;
	}
	return synced / notes.length;
}

export function rhythmReport(notes: Note[], beatsPerBar = 4): RhythmReport {
	const velocity = { min: 0, max: 0, mean: 0, stdev: 0, spread: 0 };
	if (!notes.length) return { notes: 0, bars: 0, density: 0, grid: null, gridName: "-", offGridRatio: 0, syncopation: 0, velocity };
	const vels = notes.map((n) => n.velocity);
	velocity.min = Math.min(...vels);
	velocity.max = Math.max(...vels);
	velocity.mean = vels.reduce((s, x) => s + x, 0) / vels.length;
	velocity.stdev = Math.sqrt(vels.reduce((s, x) => s + (x - velocity.mean) ** 2, 0) / vels.length);
	velocity.spread = velocity.max - velocity.min;
	const starts = notes.map((n) => n.start);
	const end = Math.max(...notes.map((n) => n.start + n.duration));
	const begin = Math.min(...starts);
	const bars = Math.max(1, Math.ceil((end - Math.floor(begin / beatsPerBar) * beatsPerBar) / beatsPerBar - 1e-9));
	const grid = detectGrid(starts);
	const off = starts.filter((t) => !onGrid(t, 0.25, 0.02) && !onGrid(t, 1 / 6, 0.02)).length / starts.length;
	return {
		notes: notes.length,
		bars,
		density: notes.length / bars,
		grid: grid?.beats ?? null,
		gridName: grid?.name ?? "вне сетки",
		offGridRatio: off,
		syncopation: syncopation(notes),
		velocity,
	};
}
