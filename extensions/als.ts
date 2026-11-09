/**
 * Чтение проектов Ableton Live (.als, любая версия 9–12) без запущенного Live.
 *
 * project_list     — где лежат проекты, свежие сверху.
 * project_summary  — сводка проекта: темп, размер, треки, устройства, клипы.
 * clip_notes       — ноты клипа.
 * project_analysis — теория по нотам: тональность, аккорды, ритм, диапазоны, энергия.
 * project_diff     — что изменилось с прошлого снимка (снимки в learner/snapshots/).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeProject } from "../lib/als/analysis.ts";
import { projectDiff } from "../lib/als/diff.ts";
import { findProjects, normalizeUserPath, projectRoots } from "../lib/als/files.ts";
import { findClip, findTrack, clipNotesText } from "../lib/als/notes.ts";
import { readProject } from "../lib/als/parse.ts";
import { summarize } from "../lib/als/summary.ts";

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

function load(cwd: string, p: string) {
	const full = normalizeUserPath(p, cwd);
	try {
		return { full, project: readProject(full) };
	} catch (e) {
		throw new Error(`Не удалось прочитать проект ${full}: ${(e as Error).message}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "project_list",
		label: "Проекты Ableton",
		description:
			"Найти файлы проектов Ableton Live (.als) в Документах (в том числе в OneDrive), на рабочем столе и в папках из MM_PROJECT_DIRS. " +
			"Backup и служебные папки пропускаются, свежие сверху. Дополнительные папки — параметр extra_dirs.",
		promptSnippet: "Найти проекты Ableton (.als) ученика, свежие сверху",
		parameters: Type.Object({
			extra_dirs: Type.Optional(Type.Array(Type.String(), { description: "Ещё папки для поиска" })),
			limit: Type.Optional(Type.Number({ description: "Сколько проектов показать, по умолчанию 20" })),
		}),
		async execute(_id, params) {
			const roots = projectRoots(params.extra_dirs ?? []);
			const files = findProjects(roots, { limit: params.limit ?? 20 });
			if (!files.length) return text(`Проектов .als не нашлось. Искал в: ${roots.join("; ") || "ни одной существующей папки"}. Спроси, где лежат проекты, и повтори с extra_dirs.`);
			const rows = files.map((f, i) => `${i + 1}. ${f.path} — ${new Date(f.mtime).toISOString().slice(0, 16).replace("T", " ")}, ${Math.round(f.size / 1024)} КБ`);
			return text(`Найдено ${files.length} (искал в: ${roots.join("; ")}):\n${rows.join("\n")}`, { files });
		},
	});

	pi.registerTool({
		name: "project_summary",
		label: "Сводка проекта",
		description:
			"Сводка проекта Ableton: версия Live, темп, размер, лад (Live 12), локаторы, длина аранжировки; треки (тип, имя, mute, цепочка устройств), " +
			"клипы Session и Arrangement (имя, позиция, длина, число нот), аудиоклипы. Читает .als любой версии, Live может быть закрыт.",
		promptSnippet: "Сводка проекта Ableton (.als): темп, треки, устройства, клипы",
		parameters: Type.Object({ path: Type.String({ description: "Путь к .als (Windows или POSIX, можно ~/…)" }) }),
		async execute(_id, params, _s, _u, ctx) {
			const { project } = load(ctx.cwd, params.path);
			return text(summarize(project), { tempo: project.tempo, liveVersion: project.liveVersion, tracks: project.tracks.length });
		},
	});

	pi.registerTool({
		name: "clip_notes",
		label: "Ноты клипа",
		description: "Ноты MIDI-клипа: такт.доля, нота, длительность, velocity. Трек и клип — по номеру (с 1, как в project_summary) или по имени.",
		promptSnippet: "Ноты MIDI-клипа проекта Ableton",
		parameters: Type.Object({
			path: Type.String({ description: "Путь к .als" }),
			track: Type.Union([Type.String(), Type.Number()], { description: "Номер трека (с 1) или имя" }),
			clip: Type.Union([Type.String(), Type.Number()], { description: "Номер клипа на треке (с 1: сначала Session, потом Arrangement, как в сводке) или имя" }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const { project } = load(ctx.cwd, params.path);
			const track = findTrack(project, params.track);
			if (!track) throw new Error(`Нет трека «${params.track}». Треков: ${project.tracks.map((t, i) => `${i + 1}:${t.name}`).join(", ")}`);
			const clip = findClip(track, params.clip);
			if (!clip) throw new Error(`Нет клипа «${params.clip}» на «${track.name}» (клипов: ${track.clips.length}: ${track.clips.slice(0, 20).map((c, i) => `${i + 1}:${c.name || "?"}`).join(", ")})`);
			return text(clipNotesText(project, track, clip));
		},
	});

	pi.registerTool({
		name: "project_analysis",
		label: "Анализ проекта",
		description:
			"Теория по нотам проекта (считает код, не модель): тональность, аккорды по тактам со ступенями, ноты вне тональности, бас против корней, " +
			"параллельные квинты/октавы, ритм (сетка, синкопы, velocity), диапазоны треков против инструментов, «грязные» интервалы в низу, " +
			"энергия по 8-тактовым блокам; по секциям, если есть локаторы. Результат комментируй, не пересказывай цифры подряд.",
		promptSnippet: "Анализ нот проекта Ableton: тональность, аккорды, ритм, диапазоны, энергия",
		parameters: Type.Object({ path: Type.String({ description: "Путь к .als" }) }),
		async execute(_id, params, _s, _u, ctx) {
			const { project } = load(ctx.cwd, params.path);
			return text(analyzeProject(project));
		},
	});

	pi.registerTool({
		name: "project_diff",
		label: "Что изменилось в проекте",
		description:
			"Что изменилось в проекте с прошлого снимка: новые/удалённые треки, клипы, устройства, ноты, темп, локаторы. Снимки лежат в learner/snapshots/ рабочей папки. " +
			"По умолчанию после сравнения записывается новый снимок (save=false — только посмотреть).",
		promptSnippet: "Что изменилось в проекте Ableton с прошлого раза",
		parameters: Type.Object({
			path: Type.String({ description: "Путь к .als" }),
			save: Type.Optional(Type.Boolean({ description: "Записать новый снимок после сравнения (по умолчанию да)" })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const { project } = load(ctx.cwd, params.path);
			const r = projectDiff(project, ctx.cwd, params.save ?? true);
			return text(r.text, { first: r.first, changes: r.changes.length });
		},
	});
}
