import { barBeat } from "./format.ts";
import type { Clip, Project, Track } from "./parse.ts";
import { noteName } from "../music/pitch.ts";

export function findTrack(p: Project, ref: string | number): Track | undefined {
	if (typeof ref === "number" || /^\d+$/.test(String(ref))) return p.tracks[Number(ref) - 1];
	const s = String(ref).toLowerCase();
	return p.tracks.find((t) => t.name.toLowerCase() === s) ?? p.tracks.find((t) => t.name.toLowerCase().includes(s));
}

export function findClip(t: Track, ref: string | number): Clip | undefined {
	if (typeof ref === "number" || /^\d+$/.test(String(ref))) return t.clips[Number(ref) - 1];
	const s = String(ref).toLowerCase();
	return t.clips.find((c) => c.name.toLowerCase() === s) ?? t.clips.find((c) => c.name.toLowerCase().includes(s));
}

const MAX_NOTES = 400;

/** Ноты клипа: «такт.доля  нота  длительность  velocity», времена от начала клипа. */
export function clipNotesText(p: Project, track: Track, clip: Clip): string {
	const bpb = (p.timeSignature[0] * 4) / p.timeSignature[1];
	const head = `Клип «${clip.name || "без имени"}» на «${track.name}», ${clip.kind === "midi" ? clip.notes.length + " нот" : "аудио"}, длина ${Math.round(clip.length * 100) / 100} долей, цикл ${clip.loopStart}–${clip.loopEnd}${clip.looped ? " (включён)" : ""}`;
	if (clip.kind !== "midi") return `${head}\nЭто аудио-клип${clip.sample ? ` (сэмпл ${clip.sample})` : ""}, нот нет.`;
	const flats = false;
	const rows = clip.notes.slice(0, MAX_NOTES).map((n) => `${barBeat(n.start, bpb).padEnd(6)} ${noteName(n.pitch, flats).padEnd(4)} dur ${Math.round(n.duration * 1000) / 1000}  vel ${Math.round(n.velocity)}`);
	const more = clip.notes.length > MAX_NOTES ? `\n…ещё ${clip.notes.length - MAX_NOTES} нот` : "";
	return `${head}\nтакт.доля  нота  длительность(доли)  velocity\n${rows.join("\n")}${more}`;
}
