import { noteName } from "../music/pitch.ts";

/** «5.3» — такт 5, доля 3 (с 1). */
export function barBeat(pos: number, beatsPerBar: number): string {
	const bar = Math.floor(pos / beatsPerBar + 1e-9) + 1;
	const beat = Math.round((pos - (bar - 1) * beatsPerBar) * 100) / 100 + 1;
	return beat === 1 ? `${bar}` : `${bar}.${beat}`;
}

export function barsLen(len: number, beatsPerBar: number): string {
	const bars = len / beatsPerBar;
	return Number.isInteger(bars) ? `${bars}т` : `${Math.round(bars * 100) / 100}т`;
}

export { noteName };
