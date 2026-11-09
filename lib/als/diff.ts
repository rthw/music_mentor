/** Снимки проекта и сравнение «что изменилось с прошлого раза». */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { barBeat, barsLen } from "./format.ts";
import type { Project } from "./parse.ts";

export interface ClipSnap {
	key: string;
	name: string;
	where: string;
	start: number;
	length: number;
	notes: number;
	hash: string;
}

export interface TrackSnap {
	id: string;
	name: string;
	type: string;
	devices: string[];
	muted: boolean;
	clips: ClipSnap[];
}

export interface Snapshot {
	version: 1;
	file: string;
	liveVersion: string;
	tempo: number;
	timeSignature: [number, number];
	locators: { time: number; name: string }[];
	tracks: TrackSnap[];
}

function noteHash(c: Project["tracks"][number]["clips"][number]): string {
	if (!c.notes.length) return "";
	const h = createHash("sha1");
	for (const n of c.notes) h.update(`${n.pitch}:${n.start}:${n.duration}:${Math.round(n.velocity)};`);
	return h.digest("hex").slice(0, 10);
}

export function snapshotOf(p: Project): Snapshot {
	return {
		version: 1,
		file: p.file,
		liveVersion: p.liveVersion,
		tempo: p.tempo,
		timeSignature: p.timeSignature,
		locators: p.locators.map((l) => ({ ...l })),
		tracks: p.tracks.map((t) => ({
			id: t.id || t.name,
			name: t.name,
			type: t.type,
			devices: [...t.devices],
			muted: t.muted,
			clips: t.clips.map((c) => ({
				key: `${c.where}|${c.where === "arrangement" ? c.start : c.scene}|${c.name}`,
				name: c.name,
				where: c.where,
				start: c.where === "arrangement" ? c.start : (c.scene ?? 0),
				length: c.length,
				notes: c.notes.length,
				hash: noteHash(c),
			})),
		})),
	};
}

export interface Change {
	kind: "tempo" | "time_signature" | "track_added" | "track_removed" | "track_renamed" | "device_added" | "device_removed" | "clip_added" | "clip_removed" | "clip_changed" | "locator_added" | "locator_removed" | "mute";
	text: string;
}

function clipDesc(c: ClipSnap, bpb: number): string {
	const pos = c.where === "arrangement" ? `Arrangement т${barBeat(c.start, bpb)}` : `Session сцена ${c.start + 1}`;
	return `«${c.name || "без имени"}» (${pos}, ${barsLen(c.length, bpb)}, ${c.notes} нот)`;
}

export function diffSnapshots(prev: Snapshot, cur: Snapshot): Change[] {
	const out: Change[] = [];
	const bpb = (cur.timeSignature[0] * 4) / cur.timeSignature[1];
	if (prev.tempo !== cur.tempo) out.push({ kind: "tempo", text: `темп ${prev.tempo} → ${cur.tempo} BPM` });
	if (prev.timeSignature.join("/") !== cur.timeSignature.join("/")) out.push({ kind: "time_signature", text: `размер ${prev.timeSignature.join("/")} → ${cur.timeSignature.join("/")}` });
	const prevTracks = new Map(prev.tracks.map((t) => [t.id, t]));
	const curTracks = new Map(cur.tracks.map((t) => [t.id, t]));
	for (const t of cur.tracks) {
		const old = prevTracks.get(t.id);
		if (!old) {
			out.push({ kind: "track_added", text: `новый трек «${t.name}» (${t.type})${t.devices.length ? ", устройства: " + t.devices.join(", ") : ""}` });
			for (const c of t.clips) out.push({ kind: "clip_added", text: `клип ${clipDesc(c, bpb)} на «${t.name}»` });
			continue;
		}
		if (old.name !== t.name) out.push({ kind: "track_renamed", text: `трек «${old.name}» переименован в «${t.name}»` });
		if (old.muted !== t.muted) out.push({ kind: "mute", text: `«${t.name}»: ${t.muted ? "выключен (mute)" : "снова включён"}` });
		for (const d of t.devices.filter((d) => !old.devices.includes(d))) out.push({ kind: "device_added", text: `«${t.name}»: добавлено устройство ${d}` });
		for (const d of old.devices.filter((d) => !t.devices.includes(d))) out.push({ kind: "device_removed", text: `«${t.name}»: убрано устройство ${d}` });
		const oldClips = new Map(old.clips.map((c) => [c.key, c]));
		const curClips = new Map(t.clips.map((c) => [c.key, c]));
		for (const c of t.clips) {
			const o = oldClips.get(c.key);
			if (!o) out.push({ kind: "clip_added", text: `клип ${clipDesc(c, bpb)} на «${t.name}»` });
			else if (o.hash !== c.hash || o.length !== c.length) out.push({ kind: "clip_changed", text: `клип ${clipDesc(c, bpb)} на «${t.name}» изменён: нот ${o.notes} → ${c.notes}${o.length !== c.length ? `, длина ${barsLen(o.length, bpb)} → ${barsLen(c.length, bpb)}` : ""}` });
		}
		for (const c of old.clips) if (!curClips.has(c.key)) out.push({ kind: "clip_removed", text: `клип ${clipDesc(c, bpb)} убран с «${t.name}»` });
	}
	for (const t of prev.tracks) if (!curTracks.has(t.id)) out.push({ kind: "track_removed", text: `трек «${t.name}» удалён` });
	const key = (l: { time: number; name: string }) => `${l.time}|${l.name}`;
	const pl = new Set(prev.locators.map(key));
	const cl = new Set(cur.locators.map(key));
	for (const l of cur.locators) if (!pl.has(key(l))) out.push({ kind: "locator_added", text: `локатор «${l.name}» на т${barBeat(l.time, bpb)}` });
	for (const l of prev.locators) if (!cl.has(key(l))) out.push({ kind: "locator_removed", text: `локатор «${l.name}» убран` });
	return out;
}

export function snapshotPath(cwd: string, file: string): string {
	const base = basename(file).replace(/\.als$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_");
	return join(cwd, "learner", "snapshots", `${base}.json`);
}

export interface DiffResult {
	first: boolean;
	changes: Change[];
	text: string;
}

/** Сравнить с прошлым снимком в learner/snapshots и (по умолчанию) записать новый. */
export function projectDiff(p: Project, cwd: string, save = true): DiffResult {
	const path = snapshotPath(cwd, p.file);
	const cur = snapshotOf(p);
	let prev: Snapshot | null = null;
	if (existsSync(path)) {
		try {
			prev = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
		} catch {
			prev = null;
		}
	}
	if (save) {
		mkdirSync(join(cwd, "learner", "snapshots"), { recursive: true });
		writeFileSync(path, JSON.stringify(cur, null, 1));
	}
	if (!prev) return { first: true, changes: [], text: `Прошлого снимка нет — это первый. ${save ? "Снимок сохранён: " + path : "Снимок не сохранён."}` };
	const changes = diffSnapshots(prev, cur);
	const text = changes.length ? "С прошлого снимка изменилось:\n" + changes.map((c) => "- " + c.text).join("\n") : "С прошлого снимка ничего не изменилось.";
	return { first: false, changes, text };
}
