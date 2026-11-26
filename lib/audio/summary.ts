/**
 * Сводки анализа для модели: коротко, цифрами, ≤ 1500 байт (в UTF-8; кириллица — по 2 байта).
 * В модель уходит только этот текст — сам звук остаётся на машине ученика.
 */

import path from "node:path";
import { BANDS, type AudioAnalysis } from "./analyze.ts";

export const SUMMARY_LIMIT = 1500;

const SHORT: Record<string, string> = { sub: "саб<60", low: "низ 60-250", lowmid: "н.сер 250-500", mid: "сер 0.5-2к", high: "верх 2-8к", air: "воздух>8к" };

/** Число с точкой и знаком минус ASCII (в UTF-8 «−» занимает 3 байта). */
export const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : x === -Infinity ? "-inf" : "?");
export const signed = (x: number, d = 1) => (x > 0 ? "+" : "") + num(x, d);

export function mmss(sec: number): string {
	const s = Math.round(sec);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const fileLabel = (a: AudioAnalysis) => path.basename(a.path);

export function headerLine(a: AudioAnalysis): string {
	const i = a.info;
	const kind = i.channels === 1 ? "моно" : i.channels === 2 ? "стерео" : `${i.channels} кан. (беру первые 2)`;
	const fmt = i.format === "float" ? `float ${i.bits}` : `${i.bits} бит`;
	return `${fileLabel(a)}: ${mmss(i.duration)}, ${(i.sampleRate / 1000).toFixed(i.sampleRate % 1000 ? 1 : 0)} кГц, ${kind}, ${fmt}.`;
}

export function kickLine(a: AudioAnalysis): string {
	const k = a.kick;
	if (k.verdict === "none" || k.stickOutDb === null) {
		return k.count >= 2 && k.regularity < 0.8
			? `Бочка/бас: низ нерегулярный (${k.count} низких онсетов), по цифрам вердикта нет.`
			: "Бочка/бас: чётких регулярных ударов в полосе 40-120 Гц не нашёл, вердикта нет.";
	}
	const base = `${k.count} ударов раз в ~${k.intervalMs} мс, в момент удара низ 40-120 Гц выше, чем между ударами, на ${num(Math.max(0, k.stickOutDb))} дБ`;
	switch (k.verdict) {
		case "clear":
			return `Бочка/бас: ${base}: бочка читается над басом.`;
		case "compete":
			return `Бочка/бас: ${base}, это мало: бас по энергии не уступает бочке (сайдчейн или развести по частотам).`;
		case "ducked":
			return `Бочка/бас: ${base}; низ просаживается рядом с ударом на ~${num(k.dipDb ?? 0, 0)} дБ: бас уже уступает во времени (дакинг).`;
		default:
			return `Бочка/бас: ${base}, пограничный случай, по цифрам вердикта нет.`;
	}
}

function blocksLine(a: AudioAnalysis): string | null {
	const b = a.blocks;
	if (!b) return null;
	const v = b.lufs;
	const head = `Громкость по ${b.bars} тактов (${num(b.tempo, 0)} BPM), LUFS:`;
	if (v.length <= 16) return `${head} ${v.map((x) => num(x)).join(" ")}.`;
	const max = Math.max(...v);
	const min = Math.min(...v);
	return `${head} ${v.length} блоков, от ${num(min)} (№${v.indexOf(min) + 1}) до ${num(max)} (№${v.indexOf(max) + 1}), первый ${num(v[0])}, последний ${num(v[v.length - 1])}.`;
}

export function flags(a: AudioAnalysis): string[] {
	const out: string[] = [];
	const l = a.loudness;
	if (l.silent) out.push("файл почти тишина (громкость ниже -70 LUFS)");
	if (l.truePeak > 0) out.push(`true peak ${num(l.truePeak)} дБ выше 0: возможен клиппинг при конвертации`);
	else if (l.truePeak > -1) out.push(`true peak ${num(l.truePeak)} дБ: запаса под -1 дБ нет`);
	if (a.stereo && a.stereo.lowCorrelation < 0.5) out.push(`низ <120 Гц расходится по фазе (корр. ${num(a.stereo.lowCorrelation, 2)})`);
	return out;
}

export function summarizeAnalysis(a: AudioAnalysis): string {
	const l = a.loudness;
	const lines: string[] = [headerLine(a)];
	lines.push(`Громкость: ${num(l.integrated)} LUFS интегр., short-term макс ${num(l.shortTermMax)}, true peak ${num(l.truePeak)} дБ, LRA ${num(l.lra)} LU; crest ${num(a.dynamics.crest)} дБ.`);
	lines.push(`Полосы (дБ от общей энергии): ${BANDS.map((b, i) => `${SHORT[b.id]} ${num(a.bands[i], 0)}`).join(" | ")}; ниже 50 Гц ${num(a.below50, 0)}.`);
	const s = a.stereo;
	if (s) lines.push(`Стерео: корр. ${num(s.correlation, 2)}, ширина ${s.widthTotal}% (по полосам ${s.width.join("/")}%); низ <120 Гц: корр. ${num(s.lowCorrelation, 2)}, в моно ${signed(s.lowMonoLoss)} дБ.`);
	else lines.push("Стерео: файл моно.");
	lines.push(kickLine(a));
	const f = flags(a);
	if (f.length) lines.push(`Заметки: ${f.join("; ")}.`);
	const bl = blocksLine(a);
	if (bl) lines.push(bl);
	lines.push("Цифры — подсказка, решают уши.");
	return fit(lines);
}

/** Склеить строки; если не влезло в лимит — убрать необязательные (блоки, потом заметки), потом обрезать. */
export function fit(lines: string[], limit = SUMMARY_LIMIT): string {
	const size = (l: string[]) => Buffer.byteLength(l.join("\n"), "utf8");
	const drop = [/^Громкость по /, /^Цифры — подсказка/, /^Заметки/];
	let cur = lines.slice();
	for (const re of drop) {
		if (size(cur) <= limit) break;
		cur = cur.filter((l) => !re.test(l));
	}
	let text = cur.join("\n");
	while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -2);
	return text;
}
