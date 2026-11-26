/**
 * Уши в цифрах: анализ wav, который ученик экспортировал из Live.
 *
 * audio_list    — свежие wav в папках проектов, Документах, на рабочем столе, в Загрузках.
 * audio_analyze — громкость (LUFS, true peak, LRA), полосы, стерео, бочка и бас; сводка ≤ 1.5 КБ.
 * audio_compare — свой трек против референса: громкость, полосы после выравнивания, ширина.
 *
 * Звук читается локально, кусками (lib/audio/); в модель уходит только короткая сводка.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeUserPath } from "../lib/als/files.ts";
import { analyzeWav, type AudioAnalysis, type AnalyzeOptions } from "../lib/audio/analyze.ts";
import { compareAnalyses } from "../lib/audio/compare.ts";
import { audioRoots, findWavs } from "../lib/audio/files.ts";
import { fileLabel, mmss, num, summarizeAnalysis } from "../lib/audio/summary.ts";
import { HOW_TO_WAV, WavError } from "../lib/audio/wav.ts";
import { headLine, quietRender } from "../lib/mm/quiet.ts";

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

function resolveWav(cwd: string, p: string | undefined, what: string): string {
	if (!p) {
		const recent = findWavs(audioRoots(), { limit: 5 });
		const list = recent.map((f) => f.path).join("; ");
		throw new Error(`Не указан ${what}. ${recent.length ? `Свежие wav: ${list}.` : "wav не нашлось: попроси экспортировать трек (File → Export Audio/Video, WAV)."}`);
	}
	const full = normalizeUserPath(p, cwd);
	try {
		if (!statSync(full).isFile()) throw new Error("не файл");
	} catch {
		if (/\.mp3$/i.test(full)) throw new Error(`Это mp3, а не wav. ${HOW_TO_WAV}`);
		throw new Error(`Нет файла ${full}. Свежие wav можно найти через audio_list.`);
	}
	return full;
}

function run(file: string, opts: AnalyzeOptions): AudioAnalysis {
	try {
		return analyzeWav(file, opts);
	} catch (e) {
		if (e instanceof WavError) throw new Error(e.message);
		throw e;
	}
}

const tempoParam = Type.Optional(Type.Number({ description: "Темп проекта, BPM (из project_summary): тогда добавится громкость по блокам из 8 тактов" }));
const bpbParam = Type.Optional(Type.Number({ description: "Долей в такте, по умолчанию 4" }));

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "audio_list",
		label: "Свежие wav",
		description:
			"Найти wav-файлы, которые ученик экспортировал: в папках проектов, Документах, на рабочем столе, в Загрузках и Музыке. " +
			"Свежие сверху. Samples и Backup пропускаются. mp3 не читаем: его нужно перетащить в Live и экспортировать в wav.",
		promptSnippet: "Найти свежие wav (экспорт из Live) для audio_analyze",
		parameters: Type.Object({
			extra_dirs: Type.Optional(Type.Array(Type.String(), { description: "Ещё папки для поиска" })),
			limit: Type.Optional(Type.Number({ description: "Сколько показать, по умолчанию 10" })),
		}),
		...quietRender(
			() => "Ищу экспортированные wav…",
			(r) => {
				const n = Array.isArray(r?.details?.files) ? r.details.files.length : 0;
				return n ? `нашёл wav: ${n}` : "wav не нашлось";
			},
		),
		async execute(_id, p) {
			const roots = audioRoots(p.extra_dirs ?? []);
			const files = findWavs(roots, { limit: p.limit ?? 10 });
			if (!files.length) return text(`wav не нашлось (искал в: ${roots.join("; ") || "нет существующих папок"}). Попроси экспортировать трек: File → Export Audio/Video, формат WAV, и сказать, куда сохранил.`);
			const rows = files.map((f, i) => `${i + 1}. ${f.path} — ${new Date(f.mtime).toISOString().slice(0, 16).replace("T", " ")}, ${(f.size / 1048576).toFixed(1)} МБ`);
			return text(`Найдено ${files.length}:\n${rows.join("\n")}`, { files });
		},
	});

	pi.registerTool({
		name: "audio_analyze",
		label: "Анализ звука",
		description:
			"Проанализировать wav локально и вернуть короткую сводку цифрами: громкость (LUFS интегральная и short-term, true peak, LRA), " +
			"баланс по полосам (саб <60, низ 60–250, низкая середина 250–500, середина, верх, воздух) в дБ относительно общей энергии, " +
			"стерео (корреляция, ширина, моно-совместимость низа), динамика (crest), бочка и бас (спорит ли бас с бочкой), " +
			"громкость по блокам из 8 тактов, если дан tempo. Только wav (16/24/32 бит, float, моно/стерео); mp3 не читает. " +
			"Агент не слышит: это цифры, а не слух — говори об этом.",
		promptSnippet: "Проанализировать wav: громкость, полосы, стерео, бочка/бас (сводка цифрами)",
		parameters: Type.Object({
			path: Type.String({ description: "Путь к wav (Windows или POSIX, можно ~/…)" }),
			tempo: tempoParam,
			beats_per_bar: bpbParam,
		}),
		...quietRender(
			(a) => `Считаю громкость и баланс: ${headLine(String(a?.path ?? "")).split(/[\\/]/).pop() || "wav"}…`,
			(r) => {
				const d = r?.details as { loudness?: { integrated: number }; info?: { duration: number } } | undefined;
				return d?.loudness ? `${mmss(d.info?.duration ?? 0)}, ${num(d.loudness.integrated)} LUFS` : "разобрал звук";
			},
		),
		async execute(_id, p, _s, _u, ctx) {
			const file = resolveWav(ctx.cwd, p.path, "wav");
			const a = run(file, { tempo: p.tempo, beatsPerBar: p.beats_per_bar });
			return text(summarizeAnalysis(a), a);
		},
	});

	pi.registerTool({
		name: "audio_compare",
		label: "Сравнение с референсом",
		description:
			"Сравнить свой wav с референсом (тоже wav): разница громкости в LU, полосы после выравнивания по громкости " +
			"(«на 4 дБ больше 250–500 Гц, почти нет саба ниже 50 Гц»), ширина стерео, true peak, LRA, crest. " +
			"Референс-mp3 не читаем: его нужно перетащить в Live на аудиодорожку и экспортировать в wav.",
		promptSnippet: "Сравнить свой wav с референсом: громкость, полосы, ширина",
		parameters: Type.Object({
			path: Type.String({ description: "Свой wav" }),
			reference: Type.String({ description: "Референс (wav)" }),
		}),
		...quietRender(
			() => "Сравниваю с референсом…",
			(r) => {
				const d = r?.details as { lufsDiff?: number } | undefined;
				return typeof d?.lufsDiff === "number" && Number.isFinite(d.lufsDiff) ? `разница по громкости ${d.lufsDiff > 0 ? "+" : ""}${num(d.lufsDiff)} LU` : "сравнил";
			},
		),
		async execute(_id, p, _s, _u, ctx) {
			const own = run(resolveWav(ctx.cwd, p.path, "свой wav"), {});
			const ref = run(resolveWav(ctx.cwd, p.reference, "референс"), {});
			const c = compareAnalyses(own, ref);
			return text(c.text, { ...c, own: fileLabel(own), reference: fileLabel(ref) });
		},
	});
}
