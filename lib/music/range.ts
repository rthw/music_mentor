/** Регистр трека против типовых диапазонов инструментов и «грязные» интервалы в басу. */

import { noteName, type Note } from "./pitch.ts";

export interface InstrumentRange {
	id: string;
	ru: string;
	low: number;
	high: number;
	/** Регулярные выражения по имени трека/устройства (нижний регистр). */
	match: RegExp;
}

// MIDI-границы звучащего диапазона, округлено; источник — общеупотребимые таблицы диапазонов оркестровых инструментов
export const INSTRUMENT_RANGES: InstrumentRange[] = [
	{ id: "synth_bass", ru: "синт-бас", low: 24, high: 55, match: /bass|бас|sub|808/ },
	{ id: "double_bass", ru: "контрабас", low: 28, high: 67, match: /contrabass|double ?bass|контрабас/ },
	{ id: "cello", ru: "виолончель", low: 36, high: 76, match: /cello|виолончел/ },
	{ id: "viola", ru: "альт", low: 48, high: 88, match: /viola|альт/ },
	{ id: "violin", ru: "скрипка", low: 55, high: 103, match: /violin|скрипк/ },
	{ id: "strings", ru: "струнные", low: 36, high: 96, match: /string|струн|ensemble/ },
	{ id: "flute", ru: "флейта", low: 60, high: 96, match: /flute|флейт|piccolo/ },
	{ id: "oboe", ru: "гобой", low: 58, high: 91, match: /oboe|гобо/ },
	{ id: "clarinet", ru: "кларнет", low: 50, high: 94, match: /clarinet|кларнет/ },
	{ id: "bassoon", ru: "фагот", low: 34, high: 75, match: /bassoon|фагот/ },
	{ id: "horn", ru: "валторна", low: 34, high: 77, match: /horn|валторн/ },
	{ id: "trumpet", ru: "труба", low: 54, high: 82, match: /trumpet|труб/ },
	{ id: "trombone", ru: "тромбон", low: 40, high: 72, match: /trombone|тромбон/ },
	{ id: "tuba", ru: "туба", low: 28, high: 58, match: /tuba|туб/ },
	{ id: "piano", ru: "фортепиано", low: 21, high: 108, match: /piano|пианино|фортепиано|keys|rhodes|electric/ },
	{ id: "pad", ru: "пэд", low: 36, high: 96, match: /pad|пэд|атмосфер|atmos/ },
];

export function guessInstrument(label: string): InstrumentRange | null {
	const s = label.toLowerCase();
	// порядок важен: «double bass» раньше «bass»
	const order = [...INSTRUMENT_RANGES].sort((a, b) => (a.id === "double_bass" ? -1 : b.id === "double_bass" ? 1 : 0));
	return order.find((r) => r.match.test(s)) ?? null;
}

export interface RangeReport {
	lowest: string;
	highest: string;
	lowPitch: number;
	highPitch: number;
	/** Нот ниже/выше диапазона инструмента. */
	below: number;
	above: number;
	instrument?: string;
	instrumentRange?: string;
}

export function rangeReport(notes: Note[], instrument?: InstrumentRange | null): RangeReport | null {
	if (!notes.length) return null;
	const lowPitch = Math.min(...notes.map((n) => n.pitch));
	const highPitch = Math.max(...notes.map((n) => n.pitch));
	const rep: RangeReport = { lowest: noteName(lowPitch), highest: noteName(highPitch), lowPitch, highPitch, below: 0, above: 0 };
	if (instrument) {
		rep.instrument = instrument.ru;
		rep.instrumentRange = `${noteName(instrument.low)}–${noteName(instrument.high)}`;
		rep.below = notes.filter((n) => n.pitch < instrument.low).length;
		rep.above = notes.filter((n) => n.pitch > instrument.high).length;
	}
	return rep;
}

export interface MuddyInterval {
	start: number;
	low: string;
	high: string;
	semitones: number;
}

/**
 * Одновременно звучащие ноты, интервал которых «мутит» в низу: терция и меньше ниже E2 (MIDI 40),
 * секунда и меньше ниже E3 (MIDI 52).
 */
export function muddyIntervals(notes: Note[]): MuddyInterval[] {
	const out: MuddyInterval[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < notes.length; i++) {
		for (let j = i + 1; j < notes.length; j++) {
			const a = notes[i];
			const b = notes[j];
			const lo = Math.min(a.pitch, b.pitch);
			const hi = Math.max(a.pitch, b.pitch);
			const iv = hi - lo;
			if (iv === 0 || iv > 4) continue;
			const overlapStart = Math.max(a.start, b.start);
			const overlapEnd = Math.min(a.start + a.duration, b.start + b.duration);
			if (overlapEnd - overlapStart <= 0.05) continue;
			const dirty = (lo < 40 && iv <= 4) || (lo < 52 && iv <= 2);
			if (!dirty) continue;
			const key = `${overlapStart.toFixed(3)}:${lo}:${hi}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ start: overlapStart, low: noteName(lo), high: noteName(hi), semitones: iv });
		}
	}
	return out.sort((a, b) => a.start - b.start);
}
