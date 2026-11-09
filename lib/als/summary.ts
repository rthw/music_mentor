/** Компактная текстовая сводка проекта для модели: читается человеком и укладывается в ~4 КБ. */

import { basename } from "node:path";
import { barBeat, barsLen } from "./format.ts";
import type { Clip, Project, Track } from "./parse.ts";
import { pcName } from "../music/pitch.ts";

const TYPE_RU: Record<string, string> = { midi: "MIDI", audio: "аудио", group: "группа", return: "возврат", main: "мастер" };
const MAX_CLIPS_SHOWN = 4;
const MAX_DEVICES_SHOWN = 6;

function clipLine(c: Clip, bpb: number): string {
	const nm = c.name || (c.kind === "audio" ? c.sample ?? "аудио" : "клип");
	const body = c.kind === "midi" ? `${c.notes.length} нот` : c.sample && c.sample !== nm ? `сэмпл ${c.sample}` : "аудио";
	const pos = c.where === "arrangement" ? `т${barBeat(c.start, bpb)}` : `сцена ${(c.scene ?? 0) + 1}`;
	return `${nm} (${pos}, ${barsLen(c.length, bpb)}, ${body})`;
}

function clipsText(clips: Clip[], where: "session" | "arrangement", bpb: number): string {
	const cs = clips.filter((c) => c.where === where);
	if (!cs.length) return "";
	const label = where === "session" ? "Session" : "Arrangement";
	const shown = cs.slice(0, MAX_CLIPS_SHOWN).map((c) => clipLine(c, bpb));
	const rest = cs.length > MAX_CLIPS_SHOWN ? `, ещё ${cs.length - MAX_CLIPS_SHOWN}` : "";
	return `${label} ${cs.length}: ${shown.join("; ")}${rest}`;
}

function trackText(t: Track, i: number, bpb: number): string {
	const flags = [t.muted ? "mute" : "", t.volumeAutomation ? "автоматизация громкости" : ""].filter(Boolean).join(", ");
	const devs = t.devices.length
		? t.devices.slice(0, MAX_DEVICES_SHOWN).join(" → ") + (t.devices.length > MAX_DEVICES_SHOWN ? ` …+${t.devices.length - MAX_DEVICES_SHOWN}` : "")
		: "без устройств";
	const head = `${i + 1}. [${TYPE_RU[t.type]}] «${t.name}»${flags ? ` (${flags})` : ""} — ${devs}`;
	const parts = [clipsText(t.clips, "session", bpb), clipsText(t.clips, "arrangement", bpb)].filter(Boolean);
	return parts.length ? `${head}\n   ${parts.join("\n   ")}` : head;
}

export function summarize(p: Project): string {
	const [num, den] = p.timeSignature;
	const bpb = (num * 4) / den;
	const lines: string[] = [];
	const nm = basename(p.file).replace(/\.als$/i, "") || "проект";
	let head = `Проект «${nm}»: ${p.creator || "Live ?"}, ${Math.round(p.tempo * 100) / 100} BPM, ${num}/${den}`;
	if (p.scale) head += `, лад Live: ${pcName(p.scale.root)} ${p.scale.name}${p.scale.inKey ? " (In Key)" : ""}`;
	lines.push(head);
	const arr = p.arrangementLength ? `Arrangement ${Math.round(p.arrangementLength / bpb)} тактов` : "Arrangement пуст";
	lines.push(`${arr}; сцен в Session: ${p.sceneCount}; треков: ${p.tracks.filter((t) => t.type !== "return").length}, возвратов: ${p.tracks.filter((t) => t.type === "return").length}`);
	if (p.locators.length) lines.push(`Локаторы: ${p.locators.map((l) => `${l.name || "?"} (т${barBeat(l.time, bpb)})`).join(", ")}`);
	p.tracks.forEach((t, i) => lines.push(trackText(t, i, bpb)));
	return lines.join("\n");
}
