/**
 * Сборка минимального .als (XML в формате Live 11/12) из описания — для тестов, где нужны
 * конкретные ноты, локаторы и автоматизация. Это синтетика, а не фикстура из Live.
 */

import { gzipSync } from "node:zlib";

export interface BClip {
	name: string;
	where?: "arrangement" | "session";
	/** Arrangement: начало в долях; Session: номер сцены. */
	start: number;
	length: number;
	notes?: { pitch: number; start: number; duration: number; velocity?: number }[];
}

export interface BTrack {
	type: "midi" | "audio" | "return";
	name: string;
	id?: number;
	devices?: string[];
	clips?: BClip[];
	volumeAutomation?: boolean;
}

export interface BProject {
	creator?: string;
	tempo?: number;
	locators?: { time: number; name: string }[];
	tracks: BTrack[];
}

function clipXml(c: BClip): string {
	const notes = c.notes ?? [];
	const byPitch = new Map<number, typeof notes>();
	for (const n of notes) (byPitch.get(n.pitch) ?? byPitch.set(n.pitch, []).get(n.pitch)!).push(n);
	const keyTracks = [...byPitch]
		.map(
			([pitch, ns], i) =>
				`<KeyTrack Id="${i}"><Notes>${ns.map((n, j) => `<MidiNoteEvent Time="${n.start}" Duration="${n.duration}" Velocity="${n.velocity ?? 100}" VelocityDeviation="0" OffVelocity="64" Probability="1" IsEnabled="true" NoteId="${j + 1}" />`).join("")}</Notes><MidiKey Value="${pitch}" /></KeyTrack>`,
		)
		.join("");
	const arr = (c.where ?? "arrangement") === "arrangement";
	return (
		`<MidiClip Id="${Math.floor(Math.random() * 1e6)}" Time="${arr ? c.start : 0}">` +
		`<CurrentStart Value="${arr ? c.start : 0}" /><CurrentEnd Value="${arr ? c.start + c.length : c.length}" />` +
		`<Loop><LoopStart Value="0" /><LoopEnd Value="${c.length}" /><StartRelative Value="0" /><LoopOn Value="false" /></Loop>` +
		`<Name Value="${c.name}" /><Notes><KeyTracks>${keyTracks}</KeyTracks></Notes></MidiClip>`
	);
}

function audioClipXml(c: BClip): string {
	return `<AudioClip Id="${Math.floor(Math.random() * 1e6)}" Time="${c.start}"><CurrentStart Value="${c.start}" /><CurrentEnd Value="${c.start + c.length}" /><Loop><LoopStart Value="0" /><LoopEnd Value="${c.length}" /><LoopOn Value="false" /></Loop><Name Value="${c.name}" /><SampleRef><FileRef><Name Value="${c.name}.wav" /></FileRef></SampleRef></AudioClip>`;
}

function trackXml(t: BTrack, i: number): string {
	const tag = t.type === "midi" ? "MidiTrack" : t.type === "audio" ? "AudioTrack" : "ReturnTrack";
	const id = t.id ?? 100 + i;
	const clips = t.clips ?? [];
	const arrClips = clips.filter((c) => (c.where ?? "arrangement") === "arrangement").map((c) => (t.type === "audio" ? audioClipXml(c) : clipXml(c))).join("");
	const maxScene = Math.max(-1, ...clips.filter((c) => c.where === "session").map((c) => c.start));
	const slots: string[] = [];
	for (let s = 0; s <= maxScene; s++) {
		const c = clips.find((x) => x.where === "session" && x.start === s);
		slots.push(`<ClipSlot Id="${s}"><ClipSlot><Value>${c ? clipXml(c) : ""}</Value></ClipSlot></ClipSlot>`);
	}
	const devices = (t.devices ?? []).map((d) => `<${d} Id="0"><UserName Value="" /></${d}>`).join("");
	const target = 5000 + id;
	const events = t.volumeAutomation
		? `<FloatEvent Id="0" Time="-63072000" Value="1" /><FloatEvent Id="1" Time="0" Value="0.2" /><FloatEvent Id="2" Time="16" Value="1" />`
		: `<FloatEvent Id="0" Time="-63072000" Value="1" />`;
	return (
		`<${tag} Id="${id}"><Name><EffectiveName Value="${t.name}" /><UserName Value="${t.name}" /></Name><Color Value="${i + 1}" /><TrackGroupId Value="-1" />` +
		`<AutomationEnvelopes><Envelopes><AutomationEnvelope Id="0"><EnvelopeTarget><PointeeId Value="${target}" /></EnvelopeTarget><Automation><Events>${events}</Events></Automation></AutomationEnvelope></Envelopes></AutomationEnvelopes>` +
		`<DeviceChain><Mixer><Speaker><Manual Value="true" /></Speaker><Volume><Manual Value="1" /><AutomationTarget Id="${target}" /></Volume></Mixer>` +
		`<MainSequencer><ClipSlotList>${slots.join("")}</ClipSlotList>` +
		(t.type === "audio" ? `<Sample><ArrangerAutomation><Events>${arrClips}</Events></ArrangerAutomation></Sample>` : `<ClipTimeable><ArrangerAutomation><Events>${arrClips}</Events></ArrangerAutomation></ClipTimeable>`) +
		`</MainSequencer><DeviceChain><Devices>${devices}</Devices></DeviceChain></DeviceChain></${tag}>`
	);
}

export function buildAlsXml(p: BProject): string {
	const locators = (p.locators ?? []).map((l, i) => `<Locator Id="${i}"><Time Value="${l.time}" /><Name Value="${l.name}" /></Locator>`).join("");
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n<Ableton MajorVersion="5" MinorVersion="12.0_12049" Creator="${p.creator ?? "Ableton Live 12.0.5"}"><LiveSet>` +
		`<Tracks>${p.tracks.map(trackXml).join("")}</Tracks>` +
		`<MainTrack><DeviceChain><Mixer><Tempo><Manual Value="${p.tempo ?? 120}" /></Tempo><TimeSignature><Manual Value="201" /></TimeSignature></Mixer></DeviceChain></MainTrack>` +
		`<Locators><Locators>${locators}</Locators></Locators></LiveSet></Ableton>`
	);
}

export function buildAls(p: BProject): Buffer {
	return gzipSync(Buffer.from(buildAlsXml(p), "utf8"));
}
