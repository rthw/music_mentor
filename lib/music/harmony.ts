/** Ноты вне тональности, бас против корней, параллельные квинты и октавы крайних голосов. */

import type { ChordSegment } from "./chords.ts";
import { MODES } from "./key.ts";
import { mod12, noteName, type Note } from "./pitch.ts";

export interface OutOfKey {
	count: number;
	total: number;
	/** Доля нот вне лада по числу нот. */
	ratio: number;
	/** Классы высот и сколько раз встретились. */
	byPc: { pc: number; count: number }[];
	/** Первые примеры: время начала и имя ноты. */
	examples: { start: number; note: string }[];
}

/**
 * Ноты вне тональности. В миноре повышенные VI и VII ступени (гармонический и мелодический) не считаются
 * чужими, а помечаются отдельно в `raisedMinor`.
 */
export function outOfKey(notes: Note[], key: { tonic: number; mode: string }): OutOfKey & { raisedMinor: number } {
	const steps = MODES[key.mode] ?? MODES.major;
	const diatonic = new Set(steps.map((s) => mod12(key.tonic + s)));
	const raised = new Set<number>();
	if (key.mode === "minor") {
		raised.add(mod12(key.tonic + 11)); // гармонический/мелодический VII
		raised.add(mod12(key.tonic + 9)); // мелодический VI
	}
	const counts = new Map<number, number>();
	const examples: OutOfKey["examples"] = [];
	let count = 0;
	let raisedMinor = 0;
	for (const n of notes) {
		const pc = mod12(n.pitch);
		if (diatonic.has(pc)) continue;
		if (raised.has(pc)) {
			raisedMinor++;
			continue;
		}
		count++;
		counts.set(pc, (counts.get(pc) ?? 0) + 1);
		if (examples.length < 5) examples.push({ start: n.start, note: noteName(n.pitch) });
	}
	const byPc = [...counts].map(([pc, c]) => ({ pc, count: c })).sort((a, b) => b.count - a.count);
	return { count, total: notes.length, ratio: notes.length ? count / notes.length : 0, byPc, examples, raisedMinor };
}

export interface BassReport {
	/** Доли басовых нот (по сегментам аккордов): корень, терция, квинта, прочее. */
	root: number;
	third: number;
	fifth: number;
	other: number;
	segments: number;
	/** true, если бас ходит не только по корням (корни < 70%). */
	movesBeyondRoots: boolean;
}

/** Бас (одна линия нот) против корней аккордов: какую ступень аккорда играет бас на старте сегмента. */
export function bassVsRoots(bass: Note[], segments: ChordSegment[]): BassReport {
	let root = 0;
	let third = 0;
	let fifth = 0;
	let other = 0;
	for (const seg of segments) {
		if (!seg.chord) continue;
		// самая низкая нота, звучащая в начале сегмента
		const sounding = bass.filter((n) => n.start < seg.to && n.start + n.duration > seg.from);
		if (!sounding.length) continue;
		const lowest = sounding.reduce((a, b) => (b.pitch < a.pitch ? b : a));
		const rel = mod12(lowest.pitch - seg.chord.root);
		if (rel === 0) root++;
		else if (rel === 3 || rel === 4) third++;
		else if (rel === 7) fifth++;
		else other++;
	}
	const segs = root + third + fifth + other;
	return { root, third, fifth, other, segments: segs, movesBeyondRoots: segs > 0 && root / segs < 0.7 };
}

export interface Parallel {
	kind: "fifths" | "octaves";
	/** Время второго интервала (доли). */
	at: number;
	/** Имена нот «низ→верх» в первой и второй вертикали. */
	from: string;
	to: string;
}

/** Крайние голоса в каждый момент начала новой ноты: самая нижняя и самая верхняя из звучащих. */
export function outerVoices(notes: Note[]): { time: number; low: number; high: number }[] {
	const times = [...new Set(notes.map((n) => Math.round(n.start * 1000) / 1000))].sort((a, b) => a - b);
	const out: { time: number; low: number; high: number }[] = [];
	for (const t of times) {
		let low = Infinity;
		let high = -Infinity;
		for (const n of notes) {
			if (n.start <= t + 1e-6 && n.start + n.duration > t + 1e-6) {
				low = Math.min(low, n.pitch);
				high = Math.max(high, n.pitch);
			}
		}
		if (low !== Infinity) out.push({ time: t, low, high });
	}
	return out;
}

/**
 * Параллельные квинты и октавы между крайними голосами: интервал (по модулю 12) 7→7 или 0→0
 * (не унисон), оба голоса двигаются в одну сторону. Это сведения о стиле, не «ошибки».
 */
export function parallelPerfects(notes: Note[]): Parallel[] {
	const v = outerVoices(notes);
	const out: Parallel[] = [];
	for (let i = 1; i < v.length; i++) {
		const a = v[i - 1];
		const b = v[i];
		const dl = b.low - a.low;
		const dh = b.high - a.high;
		if (dl === 0 || dh === 0) continue; // косвенное движение
		if (Math.sign(dl) !== Math.sign(dh)) continue; // противоположное
		const ia = a.high - a.low;
		const ib = b.high - b.low;
		if (ia === 0 || ib === 0) continue;
		const ca = mod12(ia);
		const cb = mod12(ib);
		if (ca === 7 && cb === 7) out.push({ kind: "fifths", at: b.time, from: `${noteName(a.low)}-${noteName(a.high)}`, to: `${noteName(b.low)}-${noteName(b.high)}` });
		else if (ca === 0 && cb === 0 && ia >= 12 && ib >= 12) out.push({ kind: "octaves", at: b.time, from: `${noteName(a.low)}-${noteName(a.high)}`, to: `${noteName(b.low)}-${noteName(b.high)}` });
	}
	return out;
}
