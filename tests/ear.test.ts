/**
 * Тренировка слуха: генератор заданий (lib/mm/ear.ts) и инструменты ear_next/ear_answer/
 * ear_replay/ear_finish (extensions/ear.ts) на фейковом мосте — как tests/play.test.ts.
 * Проверяем главное: задание собирается из ЕГО проекта, ответ не утекает в текст до проверки,
 * а ear_finish убирает только трек «Подсказка: Слух».
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./stubs/packages.ts";
import { buildAls } from "./alsbuild.ts";

const ear = await import("../lib/mm/ear.ts");
const parse = await import("../lib/als/parse.ts");
const ext = await import("../extensions/ear.ts");

/** A минор: Am | F | G | Am по такту плюс басовая линия A1 F1 G1 A1. */
const CHORDS = [
	...[57, 60, 64].map((pitch) => ({ pitch, start: 0, duration: 4, velocity: 90 })),
	...[53, 57, 60].map((pitch) => ({ pitch, start: 4, duration: 4, velocity: 90 })),
	...[55, 59, 62].map((pitch) => ({ pitch, start: 8, duration: 4, velocity: 90 })),
	...[57, 60, 64].map((pitch) => ({ pitch, start: 12, duration: 4, velocity: 90 })),
];
const BASS = [
	{ pitch: 33, start: 0, duration: 4, velocity: 100 },
	{ pitch: 29, start: 4, duration: 4, velocity: 100 },
	{ pitch: 31, start: 8, duration: 4, velocity: 100 },
	{ pitch: 33, start: 12, duration: 4, velocity: 100 },
];
const MELODY = [69, 72, 76, 74, 72, 69, 67, 69].map((pitch, i) => ({ pitch, start: i, duration: 1, velocity: 88 }));

function project(dir: string, opts: { bass?: boolean } = {}): string {
	const p = path.join(dir, "Ночь.als");
	const tracks = [
		{ type: "midi" as const, name: "Chords", id: 1, clips: [{ name: "Аккорды", where: "session" as const, start: 0, length: 16, notes: CHORDS }] },
		{ type: "midi" as const, name: "Melody", id: 2, clips: [{ name: "Мелодия", where: "session" as const, start: 0, length: 16, notes: MELODY }] },
	];
	if (opts.bass !== false) tracks.push({ type: "midi", name: "Bass", id: 3, clips: [{ name: "Бас", where: "session", start: 0, length: 16, notes: BASS }] });
	writeFileSync(p, buildAls({ tempo: 100, tracks }));
	return p;
}

const material = (dir: string, opts: { bass?: boolean } = {}) => ear.buildMaterial(parse.readProject(project(dir, opts)))!;

/** Постоянный «рандом»: задание в тесте и то же задание в расширении собираются одинаково. */
function fixed<T>(value: number, fn: () => Promise<T>): Promise<T> {
	const orig = Math.random;
	Math.random = () => value;
	return fn().finally(() => {
		Math.random = orig;
	});
}

// --- генератор -----------------------------------------------------------------------------

test("ear: материал из его проекта — тональность, аккорды, бас, мелодия", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	assert.equal(m.key.tonic, 9, "A");
	assert.equal(m.key.mode, "minor");
	assert.match(m.keyName, /минор/);
	assert.equal(m.beatsPerBar, 4);
	assert.equal(m.tempo, 100);
	assert.deepEqual(
		m.bass.map((n) => n.pitch),
		[33, 29, 31, 33],
		"басовая линия — его бас, а не аккорды",
	);
	assert.deepEqual(
		m.melody.slice(0, 3).map((n) => n.pitch),
		[69, 72, 76],
		"мелодия — верхний голос",
	);
	assert.ok(m.chords.length >= 3, `аккордов в материале: ${m.chords.length}`);
	assert.ok(m.chords.some((c) => c.numeral.toLowerCase() === "i"), "в A миноре первая ступень — i");
	assert.match(m.from, /Ночь\.als/);
});

test("ear: нет басового трека — бас не выдумывается", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const p = path.join(dir, "Одна мелодия.als");
	writeFileSync(p, buildAls({ tempo: 100, tracks: [{ type: "midi" as const, name: "Melody", id: 1, clips: [{ name: "Мелодия", where: "session" as const, start: 0, length: 8, notes: MELODY }] }] }));
	const m = ear.buildMaterial(parse.readProject(p))!;
	assert.equal(m.bass.length, 0, "ноты выше C3 не выдают себя за бас");
	assert.ok(!ear.availableKinds(m).includes("bass"));
	// просили бас, а его нет — задание всё равно собирается, но другого вида
	const task = ear.makeTask(m, { kind: "bass", rng: () => 0.5 });
	assert.notEqual(task.kind, "bass");
	assert.ok(task.notes.length > 0);
});

test("ear: ноты проекта нет — null, а не падение", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const p = path.join(dir, "Пусто.als");
	writeFileSync(p, buildAls({ tempo: 120, tracks: [{ type: "audio" as const, name: "Гитара", id: 1 }] }));
	assert.equal(ear.buildMaterial(parse.readProject(p)), null);
});

test("ear: интервалы идут от широких к узким, диктант растёт с 2 до 4 нот", () => {
	for (const s of ear.INTERVALS[1]) assert.ok(s.semis >= 5, `уровень 1: ${s.label}`);
	for (const s of ear.INTERVALS[2]) assert.ok(s.semis >= 3 && s.semis <= 9, `уровень 2: ${s.label}`);
	for (const s of ear.INTERVALS[3]) assert.ok(s.semis <= 2 || s.semis >= 10, `уровень 3: ${s.label}`);
	assert.deepEqual([1, 2, 3].map((l) => ear.NOTE_COUNTS[l as ear.EarLevel].dictation), [2, 3, 4]);
});

test("ear: каждое задание — варианты с ответом, ноты, объяснение", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	for (const kind of ear.EAR_KINDS) {
		for (const level of [1, 2, 3] as ear.EarLevel[]) {
			if (!ear.availableKinds(m).includes(kind)) continue;
			for (let seed = 0; seed < 1; seed += 0.13) {
				const task = ear.makeTask(m, { kind, level, rng: () => seed });
				const where = `${kind}/${level}/${seed.toFixed(2)}`;
				assert.equal(task.kind, kind, where);
				assert.ok(task.notes.length > 0, `ноты: ${where}`);
				assert.ok(task.lengthBeats >= Math.max(...task.notes.map((n) => n.start + n.duration)), `клип вмещает ноты: ${where}`);
				for (const n of task.notes) {
					assert.ok(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, `высота: ${where}`);
					assert.ok(n.start >= 0 && n.duration! > 0, `время: ${where}`);
				}
				assert.ok(task.explanation.length > 0, `объяснение: ${where}`);
				assert.ok(task.question.length > 0, `вопрос: ${where}`);
				if (task.answerKind === "choice") {
					assert.ok(task.options.length >= 2, `варианты: ${where}`);
					assert.ok(task.options.includes(task.answer), `ответ среди вариантов: ${where}`);
					assert.ok(
						ear.normalizeAnswer(task.explanation).includes(ear.normalizeAnswer(task.answer)),
						`объяснение называет ответ (${task.answer}): ${where} — ${task.explanation}`,
					);
				} else {
					assert.equal(task.goalNotes?.length, ear.NOTE_COUNTS[level].dictation, `нот в диктанте: ${where}`);
					assert.equal(task.answer, task.goalNotes!.map((n) => parse_note(n.pitch)).join(" "), `ответ диктанта — названия нот: ${where}`);
				}
			}
		}
	}
});

/** Название ноты как в lib/music: без «flats» — диез/бемоль по тональности не критично, сверяем через normalizeAnswer. */
function parse_note(pitch: number): string {
	return ear.normalizeAnswer(`${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`).toUpperCase();
}

test("ear: интервал — две ноты подряд, ответ совпадает с полутонами", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	for (const level of [1, 2, 3] as ear.EarLevel[]) {
		const task = ear.makeTask(m, { kind: "interval", level, rng: () => 0.31 });
		assert.equal(task.notes.length, 2);
		assert.ok(task.notes[1].pitch > task.notes[0].pitch, "вторая нота выше");
		const semis = task.notes[1].pitch - task.notes[0].pitch;
		const label = ear.INTERVALS[level].find((x) => x.semis === semis)?.label;
		assert.equal(task.answer, label, `полутонов ${semis}`);
	}
});

test("ear: мажор/минор — ответ по терции аккорда", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	for (const level of [1, 2, 3] as ear.EarLevel[]) {
		const task = ear.makeTask(m, { kind: "mode", level, rng: () => 0.77 });
		const pcs = [...new Set(task.notes.map((n) => n.pitch % 12))].sort((a, b) => a - b);
		const root = pcs[0];
		const third = pcs.map((p) => (p - root + 12) % 12).filter((d) => d === 3 || d === 4)[0];
		assert.equal(task.answer, third === 3 ? "минор" : "мажор", `аккорд ${pcs.join(",")}`);
		assert.deepEqual(task.options.slice().sort(), ["мажор", "минор"].sort());
	}
});

test("ear: ступень — сыгранный аккорд действительно эта ступень", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	const offsets: Record<string, number> = { I: 0, i: 0, IV: 5, iv: 5, V: 7, v: 7, vi: 9, VI: 8 };
	for (const level of [1, 2, 3] as ear.EarLevel[]) {
		for (const seed of [0.2, 0.55, 0.9]) {
			const task = ear.makeTask(m, { kind: "degree", level, rng: () => seed });
			const chord = m.chords.find((c) => c.numeral === task.answer)!;
			assert.ok(chord, `ответ ${task.answer} есть в его последовательности`);
			const want = offsets[task.answer] ?? ear_mod12(chord.root - m.key.tonic);
			assert.equal(ear_mod12(chord.root - m.key.tonic), want, `корень аккорда: ${task.answer}`);
			// среди нот задания есть квинта от корня
			const rootPitch = Math.min(...task.notes.map((n) => n.pitch));
			assert.equal(ear_mod12(rootPitch - m.key.tonic), want, `ноты задания: ${task.answer}`);
			assert.ok(task.options.includes(task.answer));
			assert.ok(task.options.length <= (level === 1 ? 2 : level === 2 ? 3 : 4), `вариантов: ${task.options.length}`);
		}
	}
});

function ear_mod12(x: number): number {
	return ((x % 12) + 12) % 12;
}

test("ear: бас — два проигрывания, отличается ровно одна нота, ответ называет её", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	for (const level of [1, 2, 3] as ear.EarLevel[]) {
		for (const seed of [0.1, 0.6]) {
			const task = ear.makeTask(m, { kind: "bass", level, rng: () => seed });
			// нот в задании столько, сколько разных высот в его басу (не больше, чем требует уровень)
			const count = Math.min(ear.NOTE_COUNTS[level].bass, new Set(m.bass.map((n) => n.pitch)).size);
			assert.equal(task.notes.length, count * 2, "две половины по нотам");
			const first = task.notes.slice(0, count);
			const second = task.notes.slice(count);
			assert.equal(second.length, count);
			const diff = first.map((n, i) => (n.pitch !== second[i].pitch ? i : -1)).filter((i) => i >= 0);
			assert.equal(diff.length, 1, `изменилась одна нота, а не ${diff.length}`);
			assert.ok(Math.abs(first[diff[0]].pitch - second[diff[0]].pitch) <= 2, "полтона или тон");
			assert.equal(task.options.length, new Set(task.options).size, "варианты не повторяются");
			assert.equal(second[0].start, count + 1, "вторая половина — после паузы");
		}
	}
});

test("ear: диктант — ноты из его мелодии, в удобном регистре", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	for (const level of [1, 2, 3] as ear.EarLevel[]) {
		const task = ear.makeTask(m, { kind: "dictation", level, rng: () => 0.42 });
		const goal = task.goalNotes!;
		assert.equal(goal.length, ear.NOTE_COUNTS[level].dictation);
		assert.deepEqual(
			goal.map((n) => n.start),
			goal.map((_, i) => i),
			"одна доля на ноту",
		);
		for (const n of goal) assert.ok(n.pitch >= 45 && n.pitch <= 84, `удобно играть: ${n.pitch}`);
		// мелодия не искажена: интервалы фразы совпадают с участком его мелодии (сдвиг — целыми октавами)
		const steps = (ns: number[]) => ns.slice(1).map((p, i) => p - ns[i]);
		const want = steps(goal.map((n) => n.pitch));
		const runs: number[][] = [];
		for (let j = 0; j + goal.length <= m.melody.length; j++) runs.push(steps(m.melody.slice(j, j + goal.length).map((n) => n.pitch)));
		assert.ok(runs.some((r) => r.every((v, i) => v === want[i])), `фраза ${want} — не из его мелодии`);
		assert.equal(task.answerKind, "notes");
		assert.equal(task.options.length, 0, "у диктанта вариантов нет");
	}
});

test("ear: подряд один и тот же вид не спрашивается", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	const kinds = ear.availableKinds(m);
	assert.ok(kinds.length >= 3);
	for (const seed of [0.05, 0.35, 0.65, 0.95]) {
		const task = ear.makeTask(m, { recent: ["interval", "mode"], rng: () => seed });
		assert.ok(!["interval", "mode"].includes(task.kind), `вид ${task.kind} при свежих interval/mode`);
	}
});

// --- проверка ответа ----------------------------------------------------------------------

test("ear: нормализация и проверка ответа словами", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const m = material(dir);
	const interval = ear.makeTask(m, { kind: "interval", level: 1, rng: () => 0.0 });
	assert.equal(interval.answer, "октава");
	assert.deepEqual(ear.gradeChoice("октава", interval), { right: true, matched: "октава" });
	assert.equal(ear.gradeChoice("Октава!", interval).right, true);
	assert.equal(ear.gradeChoice("кажется, это октава", interval).right, true);
	assert.equal(ear.gradeChoice("квинта", interval).right, false);
	assert.equal(ear.gradeChoice("", interval).right, false);
	assert.equal(ear.normalizeAnswer("Мажорный аккорд"), "мажор аккорд");
	assert.equal(ear.normalizeAnswer("IV"), "iv");
	assert.equal(ear.normalizeAnswer("4"), "iv");
	const degree = ear.makeTask(m, { kind: "degree", level: 2, rng: () => 0.5 });
	assert.equal(ear.gradeChoice(`это ${degree.answer.toUpperCase()}`, degree).right, true, `регистр не важен: ${degree.answer}`);
});

// --- расширение на фейковом мосте ----------------------------------------------------------

function fakeLive(opts: { tracks?: any[] } = {}) {
	const tracks: any[] = opts.tracks ?? [{ index: 0, name: "Bass", type: "midi", hint: false, slot_count: 8, clips: [] }];
	const seen: any[] = [];
	let lastNotes: any[] = [];
	const handler = (r: any) => {
		seen.push(r);
		switch (r.cmd) {
			case "song":
				return { ok: true, result: { tempo: 100 } };
			case "tracks":
				return { ok: true, result: { tracks: JSON.parse(JSON.stringify(tracks)) } };
			case "add_midi_track": {
				const index = tracks.length;
				const name = `Подсказка: ${r.name}`;
				tracks.push({ index, name, type: "midi", hint: true, slot_count: 8, clips: [] });
				return { ok: true, result: { index, name } };
			}
			case "add_clip": {
				const t = tracks[r.track];
				if (!t) return { ok: false, error: "Трека нет." };
				if (!/^Подсказка: /.test(t.name)) return { ok: false, error: `Мост кладёт клипы только в свои треки «Подсказка: …», а не в «${t.name}».` };
				if (t.clips.some((c: any) => c.slot === r.slot)) return { ok: false, error: `Слот ${r.slot} занят.` };
				t.clips.push({ slot: r.slot, name: `Подсказка: ${r.name}`, is_midi_clip: true });
				lastNotes = r.notes;
				return { ok: true, result: { track: r.track, slot: r.slot, name: `Подсказка: ${r.name}`, note_count: r.notes.length } };
			}
			case "fire_clip":
				return { ok: true, result: { fired: true, track: r.track, slot: r.slot } };
			case "last_clip": {
				const t = tracks.find((x) => x.name === r.track || x.index === r.track);
				if (!t) return { ok: false, error: `В Live нет трека «${r.track}».` };
				return { ok: true, result: { exists: true, is_midi_clip: true, track: t.index, track_name: t.name, slot: 0, name: "Моя попытка", how: "selected", notes: lastNotes } };
			}
			case "remove": {
				const t = tracks[r.track];
				if (!t) return { ok: false, error: "Трека нет." };
				if (!/^Подсказка: /.test(t.name)) return { ok: false, error: `«${t.name}» — трек ученика, мост его не удаляет.` };
				if (r.confirmed !== true) return { ok: false, error: "Удалить трек можно только после явного «да»." };
				tracks.splice(r.track, 1);
				return { ok: true, result: { removed: t.name, index: r.track } };
			}
			default:
				return { ok: false, error: `Неизвестная команда '${r.cmd}'.` };
		}
	};
	const server = net.createServer((sock) => {
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (d) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				sock.write(JSON.stringify(handler(req)) + "\n");
			}
		});
	});
	return new Promise<{ port: number; seen: any[]; tracks: any[]; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({ port: (server.address() as net.AddressInfo).port, seen, tracks, close: () => server.close() }),
		),
	);
}

function tools(port: number) {
	Object.assign(process.env, { MM_LIVE_PORT: String(port), MM_LIVE_HOST: "127.0.0.1" });
	const map = new Map<string, any>();
	ext.default({ registerTool: (t: any) => map.set(t.name, t) } as any);
	return map;
}

const run = (t: any, params: object, cwd: string) => t.execute("1", params, undefined, undefined, { cwd });

test("ear.ts: четыре инструмента", () => {
	assert.deepEqual([...tools(1).keys()], ["ear_next", "ear_answer", "ear_replay", "ear_finish"]);
});

test("ear_next: клип на треке «Подсказка: Слух», запуск, ответа в выдаче нет", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		const out = await fixed(0.42, () => run(t.get("ear_next"), { path: "Ночь.als", kind: "interval", level: 2 }, dir));
		const body = out.content[0].text as string;
		assert.match(body, /♪ Задание 1: какой интервал/);
		assert.match(body, /трек «Подсказка: Слух», слот 0/);
		assert.match(body, /Какой интервал/);
		assert.ok(!/Правильный ответ:/.test(body), "ответ не называется");
		assert.deepEqual(Object.keys(out.details).sort(), ["from", "kind", "level", "number", "project", "slot", "title", "track"]);
		assert.equal(out.details.answer, undefined);
		assert.deepEqual(
			live.seen.map((r) => r.cmd),
			["song", "tracks", "add_midi_track", "add_clip", "fire_clip"],
		);
		const clip = live.seen.find((r) => r.cmd === "add_clip");
		assert.match(live.tracks[1].name, /^Подсказка: Слух$/);
		assert.equal(clip.name, "Задание 1");
		assert.equal(clip.length_beats, 3);
		assert.equal(clip.notes.length, 2);
		assert.equal(live.seen.at(-1).cmd, "fire_clip");
	} finally {
		live.close();
	}
});

test("ear_next → ear_answer: верно, неверно и повторный ответ", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const file = project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		const expected = ear.makeTask(ear.buildMaterial(parse.readProject(file))!, { kind: "degree", level: 2, rng: () => 0.42 });
		await fixed(0.42, () => run(t.get("ear_next"), { path: "Ночь.als", kind: "degree", level: 2 }, dir));
		const right = await run(t.get("ear_answer"), { answer: expected.answer }, dir);
		assert.match(right.content[0].text, new RegExp(`^Верно: ${expected.answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(right.content[0].text, /Следующее задание — ear_next/);
		assert.equal(right.details.right, true);
		assert.equal(right.details.answer, expected.answer);
		const again = await run(t.get("ear_answer"), { answer: expected.answer }, dir);
		assert.match(again.content[0].text, /уже отвечали: верно/);

		const second = ear.makeTask(ear.buildMaterial(parse.readProject(file))!, { kind: "mode", level: 1, rng: () => 0.7 });
		await fixed(0.7, () => run(t.get("ear_next"), { path: "Ночь.als", kind: "mode", level: 1 }, dir));
		const wrong = await run(t.get("ear_answer"), { answer: second.answer === "мажор" ? "минор" : "мажор" }, dir);
		assert.match(wrong.content[0].text, /^Неверно:/);
		assert.ok(wrong.content[0].text.includes(second.answer), "правильный ответ назван после проверки");
		assert.match(wrong.content[0].text, /ear_replay/);
	} finally {
		live.close();
	}
});

test("ear_answer: диктант проверяется по последнему клипу его трека", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	const file = project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		const expected = ear.makeTask(ear.buildMaterial(parse.readProject(file))!, { kind: "dictation", level: 3, rng: () => 0.42 });
		await fixed(0.42, () => run(t.get("ear_next"), { path: "Ночь.als", kind: "dictation", level: 3 }, dir));
		// мост отдаст ровно ноты задания на «Bass»: ученик сыграл точно
		const out = await run(t.get("ear_answer"), { live_track: "Bass" }, dir);
		const body = out.content[0].text as string;
		assert.match(body, /^4 из 4 нот/, "вердикт сравнения");
		assert.match(body, /✓ /);
		assert.equal(out.details.right, true);
		assert.equal(out.details.answer, expected.answer);
	} finally {
		live.close();
	}
});

test("ear_answer: ошибки — до задания и без данных диктанта", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		await assert.rejects(run(t.get("ear_answer"), { answer: "квинта" }, dir), /Сначала ear_next/);
		await assert.rejects(run(t.get("ear_replay"), {}, dir), /Сначала ear_next/);
		await run(t.get("ear_next"), { path: "Ночь.als", kind: "dictation", level: 1 }, dir);
		await assert.rejects(run(t.get("ear_answer"), {}, dir), /Диктант проверяется по игре/);
		await assert.rejects(run(t.get("ear_answer"), { answer: "что-то" }, dir), /Сначала сыграй|Диктант проверяется по игре|Не вижу ответа/);
	} finally {
		live.close();
	}
});

test("ear_replay: ещё раз запускает тот же клип", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		await run(t.get("ear_next"), { path: "Ночь.als", kind: "interval" }, dir);
		const out = await run(t.get("ear_replay"), {}, dir);
		assert.match(out.content[0].text, /Проигрываю задание 1 ещё раз/);
		assert.equal(live.seen.at(-1).cmd, "fire_clip");
		assert.equal(live.seen.at(-1).slot, 0);
	} finally {
		live.close();
	}
});

test("ear_finish: убирает только свой трек и отдаёт итог", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		// два задания подряд — второе берёт следующий свободный слот того же трека
		await run(t.get("ear_next"), { path: "Ночь.als", kind: "interval" }, dir);
		await run(t.get("ear_next"), { path: "Ночь.als", kind: "mode" }, dir);
		const slots = live.seen.filter((r) => r.cmd === "add_clip").map((r) => r.slot);
		assert.deepEqual(slots, [0, 1], "слоты не перезаписываются");
		const before = live.tracks.map((t2) => t2.name);
		const out = await run(t.get("ear_finish"), {}, dir);
		const body = out.content[0].text as string;
		assert.match(body, /Трек «Подсказка: Слух» убран из Live/);
		assert.match(body, /Заданий 2/);
		const remove = live.seen.filter((r) => r.cmd === "remove");
		assert.equal(remove.length, 1);
		assert.equal(remove[0].confirmed, true);
		assert.equal(remove[0].track, 1, "индекс трека «Подсказка: Слух» — второго после «Bass»");
		assert.deepEqual(
			live.tracks.map((t2) => t2.name),
			before.filter((n) => n !== "Подсказка: Слух"),
			"треки ученика на месте",
		);
		assert.equal(out.details.removed, "Подсказка: Слух");
	} finally {
		live.close();
	}
});

test("ear_next: копия проекта перед правкой и понятная ошибка без нот", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-ear-"));
	project(dir);
	const live = await fakeLive();
	try {
		const t = tools(live.port);
		const out = await run(t.get("ear_next"), { path: "Ночь.als", kind: "interval" }, dir);
		assert.match(out.content[0].text, /Копия проекта до правок: .*learner\/backups\/\d{4}-\d{2}-\d{2}_Ночь\.als/);
	} finally {
		live.close();
	}
	const empty = path.join(dir, "Только ударные.als");
	writeFileSync(
		empty,
		buildAls({
			tempo: 100,
			tracks: [{ type: "midi" as const, name: "Drums", id: 1, clips: [{ name: "Бит", where: "session" as const, start: 0, length: 8, notes: [{ pitch: 36, start: 0, duration: 1 }, { pitch: 38, start: 2, duration: 1 }] }] }],
		}),
	);
	const t2 = tools(1);
	await assert.rejects(run(t2.get("ear_next"), { path: "Только ударные.als" }, dir), /только ударные|нет мелодических нот/);
});
