/**
 * Тренировка слуха: агент не слышит, но играет задания в Live, а ученик отвечает в чате.
 *
 * ear_next   — собрать задание по материалу его проекта, положить клип на трек «Подсказка: Слух» и
 *              запустить. Правильный ответ остаётся здесь, в состоянии сессии: модель видит только
 *              вопрос и варианты, поэтому проболтаться не может (ноты задания в Live не читай —
 *              это подглядывание, см. описание инструмента).
 * ear_answer — проверить ответ: верно/нет и что было правильно. Диктант проверяется по игре руками
 *              (played_notes или последний клип на его треке через `last_clip` из T1911).
 * ear_replay — проиграть задание ещё раз (после ошибки — сравнить на слух).
 * ear_finish — убрать трек «Подсказка: Слух» (только свой; мост не даст тронуть чужие) и отдать
 *              короткий итог сессии для профиля.
 *
 * Задание — ноты клипа, правильный ответ, варианты: `lib/mm/ear.ts` (чистые функции, tests/ear.test.ts).
 * Здесь только «где взять материал», мост и состояние сессии.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findProjects, normalizeUserPath, projectRoots } from "../lib/als/files.ts";
import { readProject, type Project } from "../lib/als/parse.ts";
import { comparePlay, compareText, compareVerdict } from "../lib/mm/compare.ts";
import { EAR_KINDS, KIND_TITLES, buildMaterial, gradeChoice, makeTask, type EarKind, type EarLevel, type EarTask } from "../lib/mm/ear.ts";
import { quietRender } from "../lib/mm/quiet.ts";
import { backupProject, bridgeAddress, call } from "./live.ts";
import { liveSource } from "./play.ts";

/** Имя трека-подсказки для заданий на слух (префикс «Подсказка: » ставит мост). */
export const EAR_TRACK = "Подсказка: Слух";

const noteSchema = Type.Object({
	pitch: Type.Number({ description: "MIDI-нота, 60 = C4" }),
	start: Type.Number({ description: "начало в долях" }),
	duration: Type.Optional(Type.Number()),
	velocity: Type.Optional(Type.Number()),
});

const KIND_PARAM = Type.String({ description: "вид задания: interval, mode, degree, bass, dictation; без него — сам выберет из доступного" });

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

interface Current {
	task: EarTask;
	number: number;
	track: number;
	slot: number;
	/** Номер строки в rows — чтобы засчитать ответ именно этому заданию. */
	row: number;
	answered?: { given: string; right: boolean };
}

interface Row {
	kind: EarKind;
	level: EarLevel;
	/** Ответ ещё не прозвучал — задание задано, но не проверено. */
	right?: boolean;
}

function readProjectFile(cwd: string, file: string): Project {
	const full = normalizeUserPath(file, cwd);
	try {
		return readProject(full);
	} catch (e) {
		throw new Error(`Не удалось прочитать проект ${full}: ${(e as Error).message}`);
	}
}

/** Проект для заданий: указанный или самый свежий из его папок (как project_list). */
function pickProject(cwd: string, file?: string): Project {
	if (file) return readProjectFile(cwd, file);
	const found = findProjects(projectRoots([cwd]), { limit: 1 });
	if (!found.length) {
		throw new Error("Не нашёл ни одного проекта .als. Скажи, в каком треке тренируемся, и повтори с path (например «Ночь.als»).");
	}
	return readProjectFile(cwd, found[0].path);
}

function summaryOf(rows: Row[]): string {
	if (!rows.length) return "Заданий ещё не было.";
	const right = rows.filter((r) => r.right === true).length;
	const byKind = new Map<EarKind, { right: number; asked: number; answered: number }>();
	for (const r of rows) {
		const acc = byKind.get(r.kind) ?? { right: 0, asked: 0, answered: 0 };
		acc.asked++;
		if (r.right !== undefined) acc.answered++;
		if (r.right) acc.right++;
		byKind.set(r.kind, acc);
	}
	const parts = [...byKind].map(([kind, v]) => `${KIND_TITLES[kind]} — ${v.asked} задан${v.asked === 1 ? "о" : "о"}, верно ${v.right} из ${v.answered}`);
	return `Заданий ${rows.length}, верно ${right}. По видам: ${parts.join("; ")}.`;
}

export default function (pi: ExtensionAPI) {
	let current: Current | undefined;
	let number = 0;
	const rows: Row[] = [];
	let backedUp = false;

	const addr = () => bridgeAddress();

	/** Копия .als перед первой записью за сессию — как в live.ts. */
	async function beforeWrite(cwd: string): Promise<string> {
		if (backedUp) return "";
		try {
			const b = await backupProject(cwd, addr());
			backedUp = true;
			return b.path ? `Копия проекта до правок: ${b.path}. ` : `Копии нет: ${b.note}. `;
		} catch (e) {
			throw new Error(`Не смог сделать копию проекта перед правкой (${(e as Error).message}); в Live ничего не менял.`);
		}
	}

	/** Трек «Подсказка: Слух» и первый пустой слот в нём. */
	async function earSlot(): Promise<{ track: number; slot: number }> {
		const all = await call({ cmd: "tracks" }, addr());
		const track = (all.tracks ?? []).find((t: any) => String(t.name) === EAR_TRACK);
		if (!track) {
			const made = await call({ cmd: "add_midi_track", name: "Слух" }, addr());
			return { track: made.index, slot: 0 };
		}
		const used = new Set<number>((track.clips ?? []).map((c: any) => Number(c.slot)));
		let slot = 0;
		while (used.has(slot)) slot++;
		const total = Number(track.slot_count ?? 0);
		if (total && slot >= total) {
			throw new Error(`На треке «${EAR_TRACK}» заняты все слоты (${total}). Скажи «закончили» — ear_finish уберёт трек и слоты освободятся.`);
		}
		return { track: track.index, slot };
	}

	async function place(task: EarTask, number: number, where: { track: number; slot: number }): Promise<void> {
		await call({ cmd: "add_clip", track: where.track, slot: where.slot, length_beats: task.lengthBeats, notes: task.notes, name: `Задание ${number}` }, addr());
		await call({ cmd: "fire_clip", track: where.track, slot: where.slot }, addr());
	}

	pi.registerTool({
		name: "ear_next",
		label: "Задание на слух",
		description:
			"Дать ученику задание на слух из ЕГО проекта и сыграть его в Live: отдельный трек «Подсказка: Слух», клип, запуск. " +
			"Виды: interval (интервал), mode (мажор/минор), degree (ступень его последовательности I/IV/V/vi), bass (какая нота баса изменилась), " +
			"dictation (2–4 ноты — ученик наигрывает на клавиатуре). Уровни 1–3: от широких интервалов к узким, вариантов и нот больше. " +
			"Правильный ответ инструмент НЕ возвращает: он ждёт в сессии и проверяется ear_answer. " +
			"Ноты задания не читай через live_clip_notes — это подглядывание, ответ узнаешь только на ear_answer.",
		promptSnippet: "Задание на слух: сыграть в Live, ответ проверяется ear_answer",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: ".als ученика; без него — самый свежий его проект" })),
			kind: Type.Optional(KIND_PARAM),
			level: Type.Optional(Type.Number({ description: "1 — широко и просто, 2 — средние, 3 — узкие интервалы и больше вариантов" })),
		}),
		...quietRender(
			(a) => (a?.kind === "dictation" ? "Готовлю диктант на слух…" : "Готовлю задание на слух…"),
			(r) => (r?.details?.number ? `♪ Задание ${r.details.number}: ${r.details.title}` : "задание сыграно"),
		),
		async execute(_id, p, _s, _u, ctx) {
			const level = (([1, 2, 3] as EarLevel[]).includes(p.level as EarLevel) ? p.level : (current ? current.task.level : 1)) as EarLevel;
			const project = pickProject(ctx.cwd, p.path);
			const material = buildMaterial(project);
			if (!material) throw new Error("В этом проекте нет мелодических нот (пустые клипы или только ударные) — тренировать слух не на чем. Выбери другой трек.");
			const kind = EAR_KINDS.includes(p.kind as EarKind) ? (p.kind as EarKind) : undefined;
			const task = makeTask(material, {
				kind,
				level,
				recent: rows.slice(-2).map((h) => h.kind),
			});
			const pre = await beforeWrite(ctx.cwd);
			const where = await earSlot();
			number += 1;
			await place(task, number, where);
			rows.push({ kind: task.kind, level });
			current = { task, number, track: where.track, slot: where.slot, row: rows.length - 1 };
			const head = `${pre}♪ Задание ${number}: ${task.title}. Играет в Live: трек «${EAR_TRACK}», слот ${where.slot} (клип «Подсказка: Задание ${number}»).`;
			const lines = [head, task.question, task.hint];
			if (task.answerKind === "notes") lines.push("Сыграй на клавиатуре (с тем же темпом, без спешки), потом скажи мне — проверю ear_answer по тому, что записал.");
			else lines.push("Скажи ответ словами — проверю через ear_answer. Правильный ответ до проверки я не показываю.");
			if (task.kind === "dictation") lines.push("Если хочешь сначала послушать ещё раз — ear_replay.");
			return text(lines.join("\n"), {
				kind: task.kind,
				level,
				number,
				title: task.title,
				track: where.track,
				slot: where.slot,
				project: project.file.split(/[\\/]/).pop(),
				from: task.from,
			});
		},
	});

	pi.registerTool({
		name: "ear_answer",
		label: "Ответ на задание",
		description:
			"Проверить ответ ученика на текущее задание на слух: верно/нет, правильный ответ и почему. " +
			"Для ответа словами — answer («квинта», «минор», «IV», «A1»). Для диктанта — то, что он сыграл: live_track (последний клип на его треке) или played_notes.",
		promptSnippet: "Проверить ответ на задание на слух (верно/нет)",
		parameters: Type.Object({
			answer: Type.Optional(Type.String({ description: "Ответ ученика словами" })),
			live_track: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Трек в Live с записанной попыткой (диктант)" })),
			played_notes: Type.Optional(Type.Array(noteSchema, { description: "Наигранное списком нот (диктант)" })),
			tolerance: Type.Optional(Type.Number({ description: "Допуск по времени в долях, по умолчанию 0.25" })),
		}),
		...quietRender(
			() => "Проверяю ответ…",
			(r) => r?.details?.verdict ?? "проверил",
		),
		async execute(_id, p) {
			if (!current) throw new Error("Сейчас нет задания на слух. Сначала ear_next.");
			const task = current.task;
			if (current.answered) {
				return text(
					`На это задание уже отвечали: ${current.answered.right ? "верно" : "неверно"} (${current.answered.given}). Правильный ответ: ${task.answer}. Следующее задание — ear_next.`,
					{ ...current.answered, answer: task.answer, number: current.number },
				);
			}

			let right: boolean;
			let verdict: string;
			let extra = task.explanation;
			let body = "";

			if (task.answerKind === "notes") {
				if (!p.played_notes?.length && p.live_track === undefined) {
					throw new Error("Диктант проверяется по игре: сыграй фразу на клавиатуре и дай live_track (трек в Live) или played_notes.");
				}
				let played: { pitch: number; start: number; duration?: number; velocity?: number }[];
				if (p.played_notes?.length) played = p.played_notes;
				else {
					const source = await liveSource(p.live_track, undefined, "сыграно");
					if (!source.notes.length) throw new Error(`В клипе пусто: ${source.label}. Запиши попытку и повтори.`);
					played = source.notes;
				}
				let tempo = 120;
				try {
					const song = await call({ cmd: "song" }, addr());
					if (typeof song.tempo === "number" && song.tempo > 0) tempo = song.tempo;
				} catch {
					// темп не критичен для сверки нот
				}
				const r = comparePlay(task.goalNotes ?? [], played, { tempo, beatsPerBar: 4, tolerance: p.tolerance });
				right = r.perfect;
				verdict = compareVerdict(r);
				body = compareText(r);
			} else {
				if (!p.answer) throw new Error("Не вижу ответа: скажи словами, что услышал (answer).");
				const g = gradeChoice(p.answer, task);
				right = g.right;
				verdict = right ? `Верно: ${task.answer}.` : `Неверно: ты сказал «${p.answer}», а правильно ${task.answer}.`;
			}

			current.answered = { given: p.answer ?? "сыграно", right };
			rows[current.row].right = right;
			const lines = [verdict];
			if (body) lines.push(body);
			lines.push(extra);
			lines.push(right ? "Следующее задание — ear_next." : "Хочешь ещё раз послушать — ear_replay, потом попробуй снова или идём дальше (ear_next).");
			return text(lines.join("\n"), { right, answer: task.answer, kind: task.kind, level: task.level, number: current.number, verdict });
		},
	});

	pi.registerTool({
		name: "ear_replay",
		label: "Проиграть задание снова",
		description: "Проиграть текущее задание на слух ещё раз: тот же клип на треке «Подсказка: Слух» запускается заново.",
		promptSnippet: "Проиграть задание на слух ещё раз",
		parameters: Type.Object({}),
		...quietRender(
			() => "Играю задание ещё раз…",
			() => "играю снова",
		),
		async execute() {
			if (!current) throw new Error("Сейчас нет задания на слух. Сначала ear_next.");
			await call({ cmd: "fire_clip", track: current.track, slot: current.slot }, addr());
			return text(`Проигрываю задание ${current.number} ещё раз: трек «${EAR_TRACK}», слот ${current.slot}.`, { number: current.number, slot: current.slot });
		},
	});

	pi.registerTool({
		name: "ear_finish",
		label: "Закончить тренировку слуха",
		description:
			"Закончить тренировку: убрать из Live трек «Подсказка: Слух» (только свой — клипов и треков ученика мост не даёт трогать) и вернуть короткий итог по заданиям для профиля.",
		promptSnippet: "Убрать трек «Подсказка: Слух» и подвести итог тренировки",
		parameters: Type.Object({}),
		...quietRender(
			() => "Убираю трек для слуха…",
			(r) => (r?.details?.removed ? "трек убран" : "убирать было нечего"),
		),
		async execute() {
			const all = await call({ cmd: "tracks" }, addr());
			const track = (all.tracks ?? []).find((t: any) => String(t.name) === EAR_TRACK);
			let removed: string | undefined;
			if (track) {
				const r = await call({ cmd: "remove", track: track.index, confirmed: true }, addr());
				removed = r.removed;
			}
			const summary = summaryOf(rows);
			current = undefined;
			const head = removed ? `Трек «${removed}» убран из Live.` : `Трека «${EAR_TRACK}» в Live нет — убирать нечего.`;
			return text(`${head} ${summary}`, { removed, summary, total: rows.length, right: rows.filter((r) => r.right === true).length });
		},
	});
}
