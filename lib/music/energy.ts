/** Энергия формы: сколько треков звучит в каждом блоке из N тактов. */

export interface TrackSpans {
	name: string;
	/** Участки звучания в долях. */
	spans: { start: number; end: number }[];
}

export interface EnergyBlock {
	/** Номер блока с 1. */
	block: number;
	fromBar: number;
	toBar: number;
	active: number;
	names: string[];
}

export function energyByBlock(tracks: TrackSpans[], opts: { blockBars?: number; beatsPerBar?: number; totalBeats?: number } = {}): EnergyBlock[] {
	const bpb = opts.beatsPerBar ?? 4;
	const blockBars = opts.blockBars ?? 8;
	const blockBeats = blockBars * bpb;
	const total = opts.totalBeats ?? Math.max(0, ...tracks.flatMap((t) => t.spans.map((s) => s.end)));
	const blocks = Math.ceil(total / blockBeats - 1e-9);
	const out: EnergyBlock[] = [];
	for (let i = 0; i < blocks; i++) {
		const from = i * blockBeats;
		const to = from + blockBeats;
		const names = tracks.filter((t) => t.spans.some((s) => s.start < to - 1e-9 && s.end > from + 1e-9)).map((t) => t.name);
		out.push({ block: i + 1, fromBar: i * blockBars + 1, toBar: (i + 1) * blockBars, active: names.length, names });
	}
	return out;
}

/** Строка кривой «█▃▅»: высота столбца = доля треков. */
export function energyCurve(blocks: EnergyBlock[]): string {
	const max = Math.max(1, ...blocks.map((b) => b.active));
	const bars = "▁▂▃▄▅▆▇█";
	return blocks.map((b) => (b.active === 0 ? "·" : bars[Math.min(7, Math.floor((b.active / max) * 7.999))])).join("");
}
