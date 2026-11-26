/**
 * Сравнение двух анализов: «твой трек» и референс.
 * Полосы заданы относительно общей энергии каждого файла — это и есть выравнивание по громкости:
 * разница полос не зависит от того, какой файл громче. Отдельно считаем, на сколько дБ подтянуть громкость.
 */

import { BANDS, type AudioAnalysis } from "./analyze.ts";
import { fileLabel, fit, num, signed } from "./summary.ts";

export interface BandDiff {
	id: string;
	name: string;
	range: string;
	/** ты − референс, дБ. */
	diff: number;
}

export interface Comparison {
	lufsDiff: number;
	/** Сколько дБ надо добавить твоему треку, чтобы сравнить на одной громкости. */
	matchGain: number;
	bands: BandDiff[];
	below50Diff: number;
	widthDiff: number | null;
	text: string;
}

/** Порог «заметно»: меньше — полосы близки. */
export const BAND_NOTICE_DB = 2;

export function compareAnalyses(a: AudioAnalysis, ref: AudioAnalysis): Comparison {
	const lufsDiff = a.loudness.integrated - ref.loudness.integrated;
	const bands = BANDS.map((b, i) => ({ id: b.id, name: b.name, range: b.range, diff: Math.round((a.bands[i] - ref.bands[i]) * 10) / 10 }));
	const below50Diff = Math.round((a.below50 - ref.below50) * 10) / 10;
	const widthDiff = a.stereo && ref.stereo ? a.stereo.widthTotal - ref.stereo.widthTotal : null;
	const lines: string[] = [];
	lines.push(`Твой ${fileLabel(a)} против референса ${fileLabel(ref)}. Полосы — после выравнивания по громкости.`);

	if (Number.isFinite(lufsDiff)) {
		const how = Math.abs(lufsDiff) < 0.5 ? "почти так же громко" : lufsDiff < 0 ? `тише на ${num(-lufsDiff)} LU` : `громче на ${num(lufsDiff)} LU`;
		lines.push(`Громкость: ты ${how} (${num(a.loudness.integrated)} против ${num(ref.loudness.integrated)} LUFS). Для сравнения на слух ${lufsDiff < 0 ? "добавь" : "убавь"} ${num(Math.abs(lufsDiff))} дБ своему (Utility Gain). True peak ${num(a.loudness.truePeak)} против ${num(ref.loudness.truePeak)} дБ, LRA ${num(a.loudness.lra)} против ${num(ref.loudness.lra)}, crest ${num(a.dynamics.crest)} против ${num(ref.dynamics.crest)} дБ.`);
	}

	const notable = bands.filter((b) => Math.abs(b.diff) >= BAND_NOTICE_DB).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
	if (notable.length) {
		lines.push(`Полосы (ты минус референс, дБ): ${notable.map((b) => `${b.name} ${b.range} ${signed(b.diff)}`).join("; ")}. Остальные в пределах ${BAND_NOTICE_DB} дБ.`);
		const strongest = notable[0];
		lines.push(`Главное: ${strongest.diff > 0 ? "больше" : "меньше"} всего у тебя ${strongest.name} (${strongest.range}) — на ${num(Math.abs(strongest.diff))} дБ ${strongest.diff > 0 ? "больше" : "меньше"}.`);
	} else lines.push(`Полосы близки: расхождение везде меньше ${BAND_NOTICE_DB} дБ.`);

	if (below50Diff <= -4) lines.push(`Ниже 50 Гц у тебя заметно меньше: ${num(a.below50, 0)} против ${num(ref.below50, 0)} дБ от общей — саба почти нет.`);
	else if (below50Diff >= 4) lines.push(`Ниже 50 Гц у тебя заметно больше: ${num(a.below50, 0)} против ${num(ref.below50, 0)} дБ от общей.`);

	if (a.stereo && ref.stereo) {
		lines.push(`Стерео: ширина ${a.stereo.widthTotal}% против ${ref.stereo.widthTotal}%; низ <120 Гц: корр. ${num(a.stereo.lowCorrelation, 2)} против ${num(ref.stereo.lowCorrelation, 2)}.`);
	} else if (a.stereo || ref.stereo) lines.push(`Стерео: ${a.stereo ? "референс моно, твой стерео" : "твой моно, референс стерео"}.`);

	if (a.kick.stickOutDb !== null && ref.kick.stickOutDb !== null) lines.push(`Бочка над низом: у тебя ${num(a.kick.stickOutDb)} дБ, у референса ${num(ref.kick.stickOutDb)} дБ.`);

	return { lufsDiff, matchGain: -lufsDiff, bands, below50Diff, widthDiff, text: fit(lines.concat("Цифры — подсказка, решают уши.")) };
}
