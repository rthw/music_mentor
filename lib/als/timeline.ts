/** Ноты проекта на общей оси времени (абсолютные доли), с разворачиванием петель клипов. */

import type { Clip, Project, Track } from "./parse.ts";
import type { Note } from "../music/pitch.ts";

const DRUM_NAME = /drum|kick|snare|hat|perc|clap|бараб|удар|808 core|hh\b/i;

export function isDrumTrack(t: Track): boolean {
	return t.devices.some((d) => /Drum Rack/.test(d)) || DRUM_NAME.test(t.name);
}

/** Ноты одного клипа, сдвинутые на позицию клипа; петля повторяется до конца клипа. */
export function clipNotesAbsolute(clip: Clip, offset: number, length = clip.length): Note[] {
	const loopLen = clip.loopEnd - clip.loopStart;
	const out: Note[] = [];
	if (loopLen <= 0 || !clip.notes.length) return out;
	const inLoop = clip.notes.filter((n) => n.start >= clip.loopStart - 1e-9 && n.start < clip.loopEnd - 1e-9);
	const repeats = clip.looped ? Math.max(1, Math.ceil(length / loopLen - 1e-9)) : 1;
	for (let r = 0; r < repeats; r++) {
		for (const n of inLoop) {
			const start = offset + r * loopLen + (n.start - clip.loopStart);
			if (start >= offset + length - 1e-9) continue;
			out.push({ ...n, start, duration: Math.min(n.duration, offset + length - start) });
		}
	}
	return out;
}

/** Смещение начала каждой сцены Session, если аранжировки нет: сцены идут одна за другой. */
export function sceneOffsets(p: Project): number[] {
	const lens: number[] = [];
	for (const t of p.tracks) for (const c of t.clips) if (c.where === "session") lens[c.scene ?? 0] = Math.max(lens[c.scene ?? 0] ?? 0, c.length);
	const offs: number[] = [];
	let acc = 0;
	for (let i = 0; i < p.sceneCount; i++) {
		offs[i] = acc;
		acc += lens[i] ?? 0;
	}
	return offs;
}

/**
 * Ноты трека на общей оси. Есть клипы Arrangement — берём их; иначе клипы Session, разложенные по сценам.
 */
export function trackNotes(p: Project, t: Track): Note[] {
	const arr = t.clips.filter((c) => c.where === "arrangement" && c.kind === "midi");
	if (arr.length) return arr.flatMap((c) => clipNotesAbsolute(c, c.start));
	const anyArrangement = p.tracks.some((x) => x.clips.some((c) => c.where === "arrangement"));
	if (anyArrangement) return [];
	const offs = sceneOffsets(p);
	return t.clips.filter((c) => c.where === "session" && c.kind === "midi").flatMap((c) => clipNotesAbsolute(c, offs[c.scene ?? 0] ?? 0));
}

/** Участки звучания трека (для кривой энергии): ноты midi-клипов и целые аудио-клипы. */
export function trackSpans(p: Project, t: Track): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const useSession = !p.tracks.some((x) => x.clips.some((c) => c.where === "arrangement"));
	const offs = useSession ? sceneOffsets(p) : [];
	for (const c of t.clips) {
		if (useSession ? c.where !== "session" : c.where !== "arrangement") continue;
		const base = useSession ? (offs[c.scene ?? 0] ?? 0) : c.start;
		if (c.kind === "audio") {
			spans.push({ start: base, end: base + c.length });
		} else {
			const ns = clipNotesAbsolute(c, base);
			if (ns.length) spans.push({ start: Math.min(...ns.map((n) => n.start)), end: Math.max(...ns.map((n) => n.start + n.duration)) });
		}
	}
	return spans;
}
