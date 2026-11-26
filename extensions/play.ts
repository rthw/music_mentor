/**
 * play_check — разбор игры руками: что ученик сыграл и где разошёлся с целью.
 *
 * Цель (эталон) — клип из проекта .als, клип из запущенного Live или список нот.
 * Сыгранное — клип из .als, список нот или (по умолчанию) последний записанный/выделенный
 * клип на треке в Live (команда моста `last_clip`; на старом мосте — запасной путь через `tracks`).
 * Сравнение и текст — в lib/mm/compare.ts; здесь только «где взять ноты».
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findClip, findTrack } from "../lib/als/notes.ts";
import { readProject, type Clip, type Note, type Project, type Track } from "../lib/als/parse.ts";
import { normalizeUserPath } from "../lib/als/files.ts";
import { comparePlay, compareText, compareVerdict, type PlayNote } from "../lib/mm/compare.ts";
import { plural, quietRender } from "../lib/mm/quiet.ts";
import { bridgeAddress, call } from "./live.ts";

const noteSchema = Type.Object({
	pitch: Type.Number({ description: "MIDI-нота, 60 = C4" }),
	start: Type.Number({ description: "начало в долях от начала клипа" }),
	duration: Type.Optional(Type.Number()),
	velocity: Type.Optional(Type.Number()),
});

const trackName = Type.Union([Type.String(), Type.Number()]);

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

const noteList = (notes: Array<{ pitch: number; start: number; duration?: number; velocity?: number }>): PlayNote[] =>
	notes.map((n) => ({ pitch: n.pitch, start: n.start, duration: n.duration ?? 0.5, velocity: n.velocity ?? 100 }));

interface Source {
	notes: PlayNote[];
	tempo?: number;
	beatsPerBar: number;
	label: string;
}

const bpbOf = (p: Project) => (p.timeSignature[0] * 4) / p.timeSignature[1];

function readAlsFile(cwd: string, file: string): Project {
	const full = normalizeUserPath(file, cwd);
	try {
		return readProject(full);
	} catch (e) {
		throw new Error(`Не удалось прочитать проект ${full}: ${(e as Error).message}`);
	}
}

function pickClip(project: Project, trackRef: unknown, clipRef: unknown): { track: Track; clip: Clip } {
	const track = findTrack(project, trackRef as string | number);
	if (!track) throw new Error(`Нет трека «${trackRef}». В проекте: ${project.tracks.map((t, i) => `${i + 1}:${t.name}`).join(", ")}`);
	const clip = findClip(track, clipRef as string | number);
	if (!clip) {
		const list = track.clips.slice(0, 20).map((c, i) => `${i + 1}:${c.name || "?"}`).join(", ");
		throw new Error(`Нет клипа «${clipRef}» на «${track.name}» (клипов ${track.clips.length}: ${list || "нет"})`);
	}
	if (clip.kind !== "midi") throw new Error(`Клип «${clip.name}» на «${track.name}» — аудио, нот в нём нет.`);
	return { track, clip };
}

function alsSource(cwd: string, file: string, trackRef: unknown, clipRef: unknown, role: string): Source {
	const project = readAlsFile(cwd, file);
	const { track, clip } = pickClip(project, trackRef, clipRef);
	return {
		notes: clip.notes.map((n: Note) => ({ ...n })),
		tempo: project.tempo,
		beatsPerBar: bpbOf(project),
		label: `${role} «${clip.name}» на «${track.name}» (${plural(clip.notes.length, "нота", "ноты", "нот")})`,
	};
}

/** Темп из запущенного Live — если цель пришла списком нот. Ошибки молчат. */
async function liveTempo(): Promise<number | undefined> {
	try {
		const song = await call({ cmd: "song" }, bridgeAddress());
		return typeof song.tempo === "number" && song.tempo > 0 ? song.tempo : undefined;
	} catch {
		return undefined;
	}
}

/** Ноты клипа из Live: конкретный слот или последний записанный/выделенный на треке.
 * Экспортируется для ear.ts: диктант проверяется по тому же last_clip (T1911). */
export async function liveSource(trackRef: unknown, slot: number | undefined, role: string): Promise<Source> {
	const addr = bridgeAddress();
	if (slot !== undefined) {
		const r = await call({ cmd: "clip_notes", track: trackRef, slot }, addr);
		if (!r.exists) throw new Error(`В слоте ${slot} на треке ${trackRef} нет клипа.`);
		return {
			notes: (r.notes ?? []).map((n: PlayNote) => ({ ...n })),
			beatsPerBar: 4,
			label: `${role} «${r.name}» на «${r.track_name ?? trackRef}» (${plural((r.notes ?? []).length, "нота", "ноты", "нот")})`,
		};
	}
	let r: any;
	try {
		r = await call({ cmd: "last_clip", track: trackRef }, addr);
	} catch (e) {
		if (!/Неизвестная команда/i.test(String((e as Error).message))) throw e;
		// Live ещё держит старый мост (без last_clip): берём последний занятый слот по `tracks`.
		const all = await call({ cmd: "tracks" }, addr);
		const track =
			typeof trackRef === "number"
				? all.tracks.find((t: any) => t.index === trackRef)
				: all.tracks.find((t: any) => t.name === trackRef) ?? all.tracks.find((t: any) => String(t.name).toLowerCase().includes(String(trackRef).toLowerCase()));
		if (!track) throw new Error(`В Live нет трека «${trackRef}».`);
		const slots = (track.clips ?? []).filter((c: any) => c.is_midi_clip);
		if (!slots.length) throw new Error(`На треке «${track.name}» нет MIDI-клипов: сначала запиши свою попытку.`);
		const last = slots[slots.length - 1];
		r = await call({ cmd: "clip_notes", track: track.index, slot: last.slot }, addr);
	}
	if (!r.exists) throw new Error(`На треке «${r.name}» нет клипов: сначала запиши свою попытку.`);
	if (r.is_midi_clip === false) throw new Error(`В последнем слоте на «${r.name}» аудиоклип «${r.clip}», нот в нём нет. Запиши попытку MIDI-клипом.`);
	return {
		notes: (r.notes ?? []).map((n: PlayNote) => ({ ...n })),
		beatsPerBar: 4,
		label: `${role} «${r.name}» на «${r.track_name ?? trackRef}», слот ${r.slot}${r.how === "playing" ? " (только что записан и играет)" : r.how === "selected" ? " (выделен в Live)" : ""} (${plural((r.notes ?? []).length, "нота", "ноты", "нот")})`,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "play_check",
		label: "Разбор игры руками",
		description:
			"Сравнить, что ученик сыграл руками, с целью: верные ноты, пропущенные, лишние, не та высота (полтона/октава отдельно), " +
			"опережение и опоздание по каждой ноте в мс и долях, общий сдвиг записи, ровность (разброс), аккорды (все ли ноты взяты, разнобой) и velocity. " +
			"Цель — из .als (path+track+clip), клип в Live (live_track+live_slot) или goal_notes; сыгранное — из .als (played_*), played_notes " +
			"или по умолчанию последний записанный/выделенный клип на live_track в Live. Ничего не меняет, только читает.",
		promptSnippet: "Разбор сыгранного руками: сравнить с целью, опоздания, разнобой в аккордах",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: ".als с целью (и с сыгранным, если played_* не заданы)" })),
			track: Type.Optional(trackName),
			clip: Type.Optional(trackName),
			goal_notes: Type.Optional(Type.Array(noteSchema, { description: "Цель списком нот вместо проекта" })),
			live_track: Type.Optional(trackName),
			live_slot: Type.Optional(Type.Number({ description: "Слот цели в Live (с 0); без него цель берётся из path/трека" })),
			played_path: Type.Optional(Type.String({ description: ".als с сыгранным клипом (по умолчанию — path)" })),
			played_track: Type.Optional(trackName),
			played_clip: Type.Optional(trackName),
			played_notes: Type.Optional(Type.Array(noteSchema, { description: "Сыгранное списком нот" })),
			tolerance: Type.Optional(Type.Number({ description: "Допуск по времени в долях, по умолчанию 0.25 (1/16)" })),
		}),
		...quietRender(
			(a) => (a?.live_track !== undefined && !a?.played_notes && !a?.played_path ? "Слушаю, что ты сыграл…" : "Сравниваю игру с целью…"),
			(r) => r?.details?.verdict ?? "разобрал",
		),
		async execute(_id, p, _s, _u, ctx) {
			const cwd = ctx.cwd;
			const haveAlsGoal = p.path && p.track !== undefined && p.clip !== undefined;
			const haveLiveGoal = p.live_track !== undefined && p.live_slot !== undefined;

			let goal: Source;
			let played: Source;
			let tempoFromGoal: number | undefined;

			// Цель.
			if (p.goal_notes?.length) {
				goal = { notes: noteList(p.goal_notes), beatsPerBar: 4, label: `список нот (${plural(p.goal_notes.length, "нота", "ноты", "нот")})` };
				tempoFromGoal = p.path ? readAlsFile(cwd, p.path).tempo : undefined;
			} else if (haveAlsGoal) {
				const s = alsSource(cwd, p.path as string, p.track, p.clip, "цель");
				goal = { ...s, notes: s.notes };
				tempoFromGoal = s.tempo;
			} else if (haveLiveGoal) {
				goal = await liveSource(p.live_track, p.live_slot as number, "цель");
			} else {
				throw new Error(
					"Не понял цель. Скажи её одним из трёх способов: path + track + clip (клип из проекта .als), goal_notes (список нот) или live_track + live_slot (клип в Live).",
				);
			}

			// Сыгранное.
			if (p.played_notes?.length) {
				played = { notes: noteList(p.played_notes), beatsPerBar: goal.beatsPerBar, label: `список нот (${plural(p.played_notes.length, "нота", "ноты", "нот")})` };
			} else if (p.played_path || p.played_track !== undefined || p.played_clip !== undefined) {
				const file = p.played_path ?? p.path;
				if (!file) throw new Error("Для сыгранного из проекта нужен путь к .als (played_path).");
				if (p.played_track === undefined || p.played_clip === undefined) {
					throw new Error("Для сыгранного из проекта нужны played_track и played_clip (трек и клип).");
				}
				const s = alsSource(cwd, file, p.played_track, p.played_clip, "сыграно");
				played = { ...s, notes: s.notes };
			} else if (p.live_track !== undefined) {
				played = await liveSource(p.live_track, undefined, "сыграно");
			} else {
				throw new Error(
					"Не вижу, что ты сыграл. Открой Live с мостом (и укажи live_track — сыгранный клип найдётся сам), или дай played_path + played_track + played_clip, или played_notes.",
				);
			}

			if (!played.notes.length) throw new Error(`В клипе пусто: ${played.label}. Запиши попытку и повтори.`);

			const tempo = tempoFromGoal ?? played.tempo ?? (await liveTempo()) ?? 120;
			const r = comparePlay(goal.notes, played.notes, { tempo, beatsPerBar: goal.beatsPerBar, tolerance: p.tolerance });
			const head = `${goal.label}; ${played.label}; темп ${Math.round(tempo)} BPM.`;
			return text(`${head}\n${compareText(r)}`, { ...r, verdict: compareVerdict(r), goal: goal.label, played: played.label });
		},
	});
}
