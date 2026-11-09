/**
 * Тональность по профилям Крумхансла–Кесслера: корреляция гистограммы классов высот
 * (вес = длительность) с профилем 24 тональностей. Отдельно — лад (дорийский и др.)
 * по набору ступеней и тонике, потому что профили Крумхансла знают только мажор и минор.
 */

import { mod12, pcName, pcWeights, prefersFlats, type Note, type Window } from "./pitch.ts";

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyResult {
	tonic: number;
	mode: "major" | "minor";
	/** Корреляция Пирсона, −1…1. */
	score: number;
	/** Отрыв от второй по счёту тональности: мало — тональность неочевидна. */
	margin: number;
	name: string;
	ranking: { tonic: number; mode: "major" | "minor"; score: number }[];
}

function pearson(a: number[], b: number[]): number {
	const n = a.length;
	const ma = a.reduce((s, x) => s + x, 0) / n;
	const mb = b.reduce((s, x) => s + x, 0) / n;
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < n; i++) {
		num += (a[i] - ma) * (b[i] - mb);
		da += (a[i] - ma) ** 2;
		db += (b[i] - mb) ** 2;
	}
	return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

function rotate(profile: number[], tonic: number): number[] {
	return profile.map((_, i) => profile[mod12(i - tonic)]);
}

export function keyName(tonic: number, mode: string): string {
	const flats = prefersFlats(tonic, mode);
	const ru = mode === "major" ? "мажор" : mode === "minor" ? "минор" : mode;
	return `${pcName(tonic, flats)} ${ru}`;
}

/** Тональность по профилям Крумхансла. Окно — в долях; без окна — все ноты. null, если нот нет. */
export function detectKey(notes: Note[], window?: Window): KeyResult | null {
	const weights = pcWeights(notes, window);
	if (weights.every((w) => w === 0)) return null;
	const ranking: KeyResult["ranking"] = [];
	for (let t = 0; t < 12; t++) {
		ranking.push({ tonic: t, mode: "major", score: pearson(weights, rotate(MAJOR, t)) });
		ranking.push({ tonic: t, mode: "minor", score: pearson(weights, rotate(MINOR, t)) });
	}
	ranking.sort((a, b) => b.score - a.score);
	const best = ranking[0];
	return { ...best, margin: best.score - ranking[1].score, name: keyName(best.tonic, best.mode), ranking: ranking.slice(0, 5) };
}

/** Тональность по окнам одинаковой длины (в долях): для секций и «куда уходит тональность». */
export function keyByWindows(notes: Note[], windows: Window[]): (KeyResult | null)[] {
	return windows.map((w) => detectKey(notes, w));
}

export const MODES: Record<string, number[]> = {
	major: [0, 2, 4, 5, 7, 9, 11],
	dorian: [0, 2, 3, 5, 7, 9, 10],
	phrygian: [0, 1, 3, 5, 7, 8, 10],
	lydian: [0, 2, 4, 6, 7, 9, 11],
	mixolydian: [0, 2, 4, 5, 7, 9, 10],
	minor: [0, 2, 3, 5, 7, 8, 10],
	locrian: [0, 1, 3, 5, 6, 8, 10],
};

export interface ModeResult {
	tonic: number;
	mode: string;
	name: string;
	/** Доля веса на нотах лада. */
	coverage: number;
}

/**
 * Лад: тоника — класс высот с наибольшим весом (басовые ноты и ноты на сильных долях весят вдвое),
 * лад — тот, чьи ступени от этой тоники покрывают наибольшую долю звучания.
 */
export function detectMode(notes: Note[], window?: Window): ModeResult | null {
	const w = pcWeights(notes, window);
	const total = w.reduce((s, x) => s + x, 0);
	if (total === 0) return null;
	// акценты: самая низкая нота каждого момента начала и ноты на целых долях
	const accent = new Array<number>(12).fill(0);
	const byStart = new Map<number, Note[]>();
	for (const n of notes) {
		if (window && (n.start + n.duration <= window.from || n.start >= window.to)) continue;
		const k = Math.round(n.start * 1000);
		(byStart.get(k) ?? byStart.set(k, []).get(k)!).push(n);
	}
	for (const group of byStart.values()) {
		const low = group.reduce((a, b) => (b.pitch < a.pitch ? b : a));
		accent[mod12(low.pitch)] += low.duration;
	}
	const score = w.map((x, i) => x + accent[i]);
	let best: ModeResult | null = null;
	let bestScore = -1;
	for (let t = 0; t < 12; t++) {
		for (const [mode, steps] of Object.entries(MODES)) {
			const inside = steps.reduce((s, st) => s + w[mod12(t + st)], 0) / total;
			// тоника важнее покрытия: за равного покрытия побеждает кандидат с самой весомой тоникой
			const s = inside * 10 + score[t] / (total + 1e-9);
			// мажор и минор — основные лады, остальные чуть дороже, чтобы не подменять очевидное
			const penalty = mode === "major" || mode === "minor" ? 0 : 0.01;
			if (s - penalty > bestScore) {
				bestScore = s - penalty;
				best = { tonic: t, mode, name: "", coverage: inside };
			}
		}
	}
	if (best) best.name = keyName(best.tonic, best.mode);
	return best;
}

/** Классы высот лада/тональности. */
export function scaleOf(tonic: number, mode: string): Set<number> {
	return new Set((MODES[mode] ?? MODES.major).map((s) => mod12(tonic + s)));
}
