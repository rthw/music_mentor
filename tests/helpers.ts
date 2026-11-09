import type { Note } from "../lib/music/pitch.ts";

export const PC: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };

/** "C4" -> 60 */
export function midi(name: string): number {
	const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
	if (!m) throw new Error(`плохая нота ${name}`);
	return PC[m[1]] + (Number(m[2]) + 1) * 12;
}

/** Блочные аккорды: по одному на такт, нижняя нота — бас на октаву ниже. */
export function blockChords(bars: string[][], opts: { beatsPerBar?: number; vel?: number } = {}): Note[] {
	const bpb = opts.beatsPerBar ?? 4;
	const notes: Note[] = [];
	bars.forEach((chord, i) => {
		for (const name of chord) notes.push({ pitch: midi(name), start: i * bpb, duration: bpb, velocity: opts.vel ?? 90 });
	});
	return notes;
}

export function line(items: [string, number, number][], vel = 90): Note[] {
	return items.map(([n, s, d]) => ({ pitch: midi(n), start: s, duration: d, velocity: vel }));
}
