/** Общие определения для анализа нот. Время — в долях (четвертных нотах), высота — MIDI. */

export interface Note {
	pitch: number;
	start: number;
	duration: number;
	velocity: number;
}

export const PC_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const PC_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** Тональности, где принято писать бемолями (по тонике и ладу). */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // D G C F Bb Eb

export function pcName(pc: number, flats = false): string {
	const i = ((pc % 12) + 12) % 12;
	return (flats ? PC_NAMES_FLAT : PC_NAMES_SHARP)[i];
}

export function prefersFlats(tonic: number, mode: string): boolean {
	return mode === "minor" || mode === "dorian" || mode === "phrygian" ? FLAT_MINOR.has(tonic) : FLAT_MAJOR.has(tonic);
}

/** «C4» = 60, как в Live (middle C = C3 у Ableton, но здесь научная нотация: 60 = C4). */
export function noteName(pitch: number, flats = false): string {
	return `${pcName(pitch, flats)}${Math.floor(pitch / 12) - 1}`;
}

export function mod12(n: number): number {
	return ((n % 12) + 12) % 12;
}

export interface Window {
	from: number;
	to: number;
}

/** Длительность ноты внутри окна [from, to). Без окна — вся длительность. */
export function weightIn(n: Note, w?: Window): number {
	if (!w) return n.duration;
	return Math.max(0, Math.min(n.start + n.duration, w.to) - Math.max(n.start, w.from));
}

/** Вес по классам высот: сумма длительностей внутри окна. */
export function pcWeights(notes: Note[], w?: Window): number[] {
	const out = new Array<number>(12).fill(0);
	for (const n of notes) out[mod12(n.pitch)] += weightIn(n, w);
	return out;
}

export function sortedByStart(notes: Note[]): Note[] {
	return [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}
