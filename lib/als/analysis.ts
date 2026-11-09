/** project_analysis: метрики lib/music по проекту, по секциям (локаторам), текстом. */

import { barBeat } from "./format.ts";
import type { Project } from "./parse.ts";
import { isDrumTrack, trackNotes, trackSpans } from "./timeline.ts";
import {
	bassVsRoots,
	chordsByBar,
	detectKey,
	detectMode,
	energyByBlock,
	energyCurve,
	guessInstrument,
	keyName,
	muddyIntervals,
	outOfKey,
	parallelPerfects,
	progressionString,
	rangeReport,
	rhythmReport,
	type Note,
	type Window,
} from "../music/index.ts";

const BASS_NAME = /bass|бас|sub|808/i;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface Section {
	name: string;
	from: number;
	to: number;
}

/** Секции по локаторам; без локаторов — один блок на весь проект. */
export function sections(p: Project, endBeat: number): Section[] {
	const locs = p.locators.filter((l) => l.time >= 0);
	if (!locs.length) return [{ name: "весь проект", from: 0, to: endBeat }];
	const out: Section[] = [];
	if (locs[0].time > 0) out.push({ name: "до первого локатора", from: 0, to: locs[0].time });
	locs.forEach((l, i) => out.push({ name: l.name || `локатор ${i + 1}`, from: l.time, to: locs[i + 1]?.time ?? Math.max(endBeat, l.time + 1) }));
	return out;
}

export function analyzeProject(p: Project): string {
	const bpb = (p.timeSignature[0] * 4) / p.timeSignature[1];
	const lines: string[] = [];
	const trackData = p.tracks
		.filter((t) => t.type === "midi" || t.type === "audio")
		.map((t) => ({ t, notes: trackNotes(p, t), drum: isDrumTrack(t), spans: trackSpans(p, t) }));
	const pitched = trackData.filter((x) => !x.drum && x.notes.length);
	const all: Note[] = pitched.flatMap((x) => x.notes);
	const endBeat = Math.max(p.arrangementLength, ...trackData.flatMap((x) => x.spans.map((s) => s.end)), 0);
	lines.push(`Анализ «${p.file.split(/[\\/]/).pop()}»: ${pitched.length} мелодических MIDI-треков с нотами, длина ${Math.round(endBeat / bpb)} тактов.`);
	if (p.scale?.inKey) lines.push(`Лад Live (подсказка пользователя): ${keyName(p.scale.root, p.scale.name.toLowerCase().startsWith("minor") ? "minor" : "major")} / ${p.scale.name}`);
	if (!all.length) {
		lines.push("Нот для анализа нет (пустые клипы или только аудио/ударные).");
		appendEnergy(lines, p, trackData, bpb, endBeat);
		return lines.join("\n");
	}

	const key = detectKey(all)!;
	const mode = detectMode(all);
	lines.push(`Тональность (Крумхансл): ${key.name}, уверенность ${key.score.toFixed(2)}${key.margin < 0.05 ? " — неочевидна (близкие кандидаты: " + key.ranking.slice(1, 3).map((r) => keyName(r.tonic, r.mode)).join(", ") + ")" : ""}`);
	if (mode && mode.mode !== key.mode) lines.push(`Лад по ступеням: ${mode.name} (${pct(mode.coverage)} нот в ладу)`);
	const kObj = { tonic: key.tonic, mode: key.mode };

	const secs = sections(p, endBeat);
	if (secs.length > 1) {
		lines.push("Секции:");
		for (const s of secs) {
			const k = detectKey(all, { from: s.from, to: s.to } as Window);
			const active = trackData.filter((x) => x.spans.some((sp) => sp.start < s.to && sp.end > s.from)).length;
			lines.push(`  «${s.name}» т${barBeat(s.from, bpb)}–${barBeat(s.to, bpb)}: ${k ? k.name : "нет нот"}, звучит треков: ${active}`);
		}
	}

	const harmonic = pitched.filter((x) => !BASS_NAME.test(x.t.name));
	const harmNotes = harmonic.flatMap((x) => x.notes);
	const bassTracks = pitched.filter((x) => BASS_NAME.test(x.t.name) || medianPitch(x.notes) < 48);
	const mixed = (harmNotes.length ? harmNotes : all).concat(bassTracks.flatMap((x) => x.notes));
	// аккорды: по секциям со своей тональностью (ступени считаются от ключа секции), иначе по всему проекту
	const mixedAll = dedupe(mixed);
	const chordRanges: { label: string; key: { tonic: number; mode: string }; from: number; to: number }[] = [];
	if (secs.length > 1) {
		for (const s of secs) {
			const sk = detectKey(mixedAll, { from: s.from, to: s.to } as Window);
			if (sk) chordRanges.push({ label: ` «${s.name}», ${sk.name}`, key: { tonic: sk.tonic, mode: sk.mode }, from: s.from, to: Math.min(s.to, s.from + 16 * bpb) });
		}
	} else chordRanges.push({ label: "", key: kObj, from: 0, to: Math.min(endBeat, 32 * bpb) });
	const segs: ReturnType<typeof chordsByBar> = [];
	for (const r of chordRanges) {
		const part = chordsByBar(mixedAll, { beatsPerBar: bpb, key: r.key, range: { from: r.from, to: r.to } });
		segs.push(...part);
		if (part.some((x) => x.chord)) {
			lines.push(`Аккорды${r.label} (т${barBeat(r.from, bpb)}–${Math.ceil(r.to / bpb)}): ${progressionString(part)}`);
			lines.push(`  ступени: ${progressionString(part, true)}`);
		}
	}
	const withChords = segs.filter((s) => s.chord);
	if (withChords.length) {
		const sevenths = withChords.filter((s) => s.chord!.shape.includes("7")).length;
		const inv = withChords.filter((s) => s.chord!.inversion > 0).length;
		const sus = withChords.filter((s) => /sus/.test(s.chord!.shape)).length;
		lines.push(`  септаккордов ${sevenths}/${withChords.length}, обращений ${inv}, sus ${sus}`);
		for (const b of bassTracks.slice(0, 1)) {
			const r = bassVsRoots(b.notes, segs);
			if (r.segments) lines.push(`Бас «${b.t.name}» против корней: корень ${r.root}, терция ${r.third}, квинта ${r.fifth}, другое ${r.other}${r.movesBeyondRoots ? " — бас ходит не только по корням" : " — бас на корнях"}`);
		}
	} else {
		lines.push("Аккорды: вертикалей из трёх и более звуков не найдено (одноголосие или редкая фактура).");
	}

	const out = outOfKey(all, kObj);
	lines.push(`Ноты вне тональности: ${out.count} из ${out.total} (${pct(out.ratio)})${out.byPc.length ? ", чаще всего " + out.byPc.slice(0, 3).map((x) => `${noteNameOf(x.pc)}×${x.count}`).join(", ") : ""}${out.raisedMinor ? `; повышенные VI–VII ступени минора: ${out.raisedMinor}` : ""}`);

	const parallels = parallelPerfects(mixed);
	if (parallels.length) lines.push(`Параллельные квинты/октавы крайних голосов: ${parallels.length}, например т${barBeat(parallels[0].at, bpb)} (${parallels[0].kind === "fifths" ? "квинты" : "октавы"} ${parallels[0].from} → ${parallels[0].to}). Это стилистический признак, не ошибка.`);

	lines.push("Треки:");
	for (const x of pitched) {
		const r = rhythmReport(x.notes, bpb);
		const inst = guessInstrument(x.t.name) ?? guessInstrument(x.t.devices.join(" "));
		const rg = rangeReport(x.notes, inst);
		const muddy = muddyIntervals(x.notes);
		const bits = [
			`${x.notes.length} нот`,
			rg ? `диапазон ${rg.lowest}–${rg.highest}` : "",
			rg?.instrument ? `(${rg.instrument} ${rg.instrumentRange}${rg.below + rg.above ? `, вне диапазона: ${rg.below + rg.above}` : ""})` : "",
			`сетка ${r.gridName}`,
			`плотность ${Math.round(r.density * 10) / 10}/такт`,
			`синкоп ${pct(r.syncopation)}`,
			`velocity ${Math.round(r.velocity.min)}–${Math.round(r.velocity.max)}${r.velocity.spread === 0 ? " (одинаковая)" : ""}`,
			muddy.length ? `«грязных» интервалов в низу: ${muddy.length} (т${barBeat(muddy[0].start, bpb)} ${muddy[0].low}+${muddy[0].high})` : "",
		].filter(Boolean);
		lines.push(`  «${x.t.name}»: ${bits.join(", ")}`);
	}
	for (const x of trackData.filter((y) => y.drum && y.notes.length)) {
		const r = rhythmReport(x.notes, bpb);
		lines.push(`  «${x.t.name}» (ударные): ${x.notes.length} нот, сетка ${r.gridName}, синкоп ${pct(r.syncopation)}, velocity ${Math.round(r.velocity.min)}–${Math.round(r.velocity.max)}`);
	}
	appendEnergy(lines, p, trackData, bpb, endBeat);
	return lines.join("\n");
}

function appendEnergy(lines: string[], _p: Project, trackData: { t: { name: string }; spans: { start: number; end: number }[] }[], bpb: number, endBeat: number): void {
	if (!endBeat) return;
	const blocks = energyByBlock(trackData.map((x) => ({ name: x.t.name, spans: x.spans })), { beatsPerBar: bpb, blockBars: 8, totalBeats: endBeat });
	if (!blocks.length) return;
	lines.push(`Энергия (треков в 8-тактовых блоках): ${energyCurve(blocks)}  [${blocks.map((b) => b.active).join(" ")}]`);
}

function noteNameOf(pc: number): string {
	return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pc];
}

function medianPitch(notes: Note[]): number {
	const s = notes.map((n) => n.pitch).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Убрать дубли одинаковых нот из разных треков (одновременно, на той же высоте). */
function dedupe(notes: Note[]): Note[] {
	const seen = new Set<string>();
	const out: Note[] = [];
	for (const n of notes) {
		const k = `${n.pitch}|${n.start.toFixed(3)}|${n.duration.toFixed(3)}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(n);
	}
	return out;
}
