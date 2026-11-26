import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePlay, compareText, compareVerdict, type PlayNote } from "../lib/mm/compare.ts";

/** Бас «Ночи»: восьмёрка нот в 16 долях, как в фикстуре vm_session_chords.als. */
const BASS: PlayNote[] = [
	{ pitch: 36, start: 0, duration: 3, velocity: 100 }, // C2
	{ pitch: 48, start: 3, duration: 1, velocity: 90 }, // C3
	{ pitch: 31, start: 4, duration: 3, velocity: 100 }, // G1
	{ pitch: 38, start: 7, duration: 1, velocity: 90 }, // D2
	{ pitch: 33, start: 8, duration: 3, velocity: 100 }, // A1
	{ pitch: 45, start: 11, duration: 1, velocity: 90 }, // A2
	{ pitch: 29, start: 12, duration: 3, velocity: 100 }, // F1
	{ pitch: 36, start: 15, duration: 1, velocity: 90 }, // C2
];

const TEMPO = 100;
const opts = { tempo: TEMPO };

test("compare: идеальная игра — всё верно, ни одной ошибки", () => {
	const r = comparePlay(BASS, BASS.map((n) => ({ ...n })), opts);
	assert.equal(r.correct.length, 8);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(r.extra, []);
	assert.deepEqual(r.wrongPitch, []);
	assert.equal(r.perfect, true);
	assert.equal(r.shift.beats, 0);
	assert.equal(r.timing.meanMs, 0);
	assert.equal(r.timing.spreadMs, 0);
	assert.equal(r.chords.total, 0, "в басу нет одновременных нот — аккордов не должно быть");
	assert.match(compareText(r), /8 из 8 нот верно/);
});

test("compare: начал на долю позже — это общий сдвиг, а не ошибка каждой ноты", () => {
	const played = BASS.map((n) => ({ ...n, start: n.start + 1 }));
	const r = comparePlay(BASS, played, opts);
	assert.equal(r.shift.beats, 1);
	assert.equal(r.shift.ms, 600);
	assert.equal(r.correct.length, 8);
	assert.equal(r.perfect, true);
	for (const c of r.correct) assert.equal(c.offsetMs, 0, "после учёта сдвига ноты ровные");
	assert.match(compareText(r), /сдвинута на \+1 долю \(600 мс\)/);
});

test("compare: одна нота на полтона ниже — «не та высота», а не пропуск", () => {
	const played = BASS.map((n) => ({ ...n }));
	played[4] = { ...played[4], pitch: 32 }; // A1 -> Ab1
	const r = comparePlay(BASS, played, opts);
	assert.equal(r.correct.length, 7);
	assert.equal(r.wrongPitch.length, 1);
	assert.equal(r.wrongPitch[0].kind, "полтона");
	assert.equal(r.wrongPitch[0].semitones, -1);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(r.extra, []);
	assert.equal(r.perfect, false);
	const text = compareText(r);
	assert.match(text, /1 не та высота/);
	assert.match(text, /A1 → G#1/);
});

test("compare: октава считается отдельно от полтона", () => {
	const goal: PlayNote[] = [{ pitch: 36, start: 0 }, { pitch: 43, start: 2 }];
	const played: PlayNote[] = [{ pitch: 36, start: 0 }, { pitch: 55, start: 2 }]; // G2 -> G3
	const r = comparePlay(goal, played, opts);
	assert.equal(r.wrongPitch.length, 1);
	assert.equal(r.wrongPitch[0].kind, "октава");
	assert.equal(r.wrongPitch[0].semitones, 12);
	assert.match(compareText(r), /октава выше/);
});

test("compare: пропуск и лишняя нота", () => {
	const played = BASS.filter((n) => n.start !== 7).map((n) => ({ ...n })); // пропустил D2
	played.push({ pitch: 40, start: 9.5, duration: 0.5, velocity: 100 }); // и взял E2 не туда
	const r = comparePlay(BASS, played, opts);
	assert.equal(r.correct.length, 7);
	assert.equal(r.missing.length, 1);
	assert.equal(r.missing[0].start, 7);
	assert.equal(r.extra.length, 1);
	assert.equal(r.extra[0].start, 9.5);
	assert.equal(r.wrongPitch.length, 0);
	const text = compareText(r);
	assert.match(text, /1 пропущено/);
	assert.match(text, /1 лишних/);
	assert.match(text, /пропуск/);
	assert.match(text, /лишняя E2/);
});

test("compare: живое опоздание ±15 мс — норма, не ошибка", () => {
	// 120 BPM: 15 мс = 0.03 доли, при допуске 1/16 (0.25) это глубоко внутри.
	const live = { tempo: 120 };
	const jitter = [15, -12, 8, -15, 10, 0, 14, -9];
	const played = BASS.map((n, i) => ({ ...n, start: n.start + jitter[i] / 500 }));
	const r = comparePlay(BASS, played, live);
	assert.equal(r.perfect, true);
	assert.equal(r.correct.length, 8);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(r.extra, []);
	assert.equal(r.shift.beats, 0, "мелкий сдвиг не выдаём за «начал позже»");
	assert.ok(Math.abs(r.timing.meanMs) <= 15);
	assert.ok(r.timing.spreadMs <= 15);
});

test("compare: аккорд — все ноты взяты, но с разнобоем", () => {
	const goal: PlayNote[] = [
		{ pitch: 60, start: 0, duration: 4 },
		{ pitch: 64, start: 0, duration: 4 },
		{ pitch: 67, start: 0, duration: 4 },
		{ pitch: 72, start: 0, duration: 4 },
	];
	// Разнобой: нижняя нота точно, остальные на 10, 25 и 50 мс позже (120 BPM, 1 доля = 500 мс).
	const offsets = [0, 0.02, 0.05, 0.1];
	const played = goal.map((n, i) => ({ ...n, start: n.start + offsets[i] }));
	const r = comparePlay(goal, played, { tempo: 120 });
	assert.equal(r.chords.total, 1);
	assert.equal(r.chords.complete, 1);
	assert.equal(r.chords.groups[0].taken, 4);
	assert.equal(r.chords.groups[0].complete, true);
	assert.equal(r.chords.groups[0].spreadMs, 50);
	assert.equal(r.perfect, true, "разнобой в допуске — не ошибка нот");
	assert.match(compareText(r), /Аккорды: 1 из 1 взяты полностью/);
	assert.match(compareText(r), /разнобой внутри аккорда/);
});

test("compare: неполный аккорд видно отдельно", () => {
	const goal: PlayNote[] = [
		{ pitch: 60, start: 0, duration: 4 },
		{ pitch: 64, start: 0, duration: 4 },
		{ pitch: 67, start: 0, duration: 4 },
	];
	const played = goal.slice(0, 2).map((n) => ({ ...n }));
	const r = comparePlay(goal, played, { tempo: 120 });
	assert.equal(r.chords.total, 1);
	assert.equal(r.chords.complete, 0);
	assert.equal(r.chords.groups[0].taken, 2);
	assert.equal(r.missing.length, 1);
	assert.match(compareText(r), /неполные: 1/);
});

test("compare: velocity ровная и неровная", () => {
	const even = BASS.map((n) => ({ ...n, velocity: 90 }));
	assert.equal(comparePlay(BASS, even, opts).velocity?.sd, 0);
	const uneven = BASS.map((n, i) => ({ ...n, velocity: i % 2 ? 40 : 120 }));
	const r = comparePlay(BASS, uneven, opts);
	assert.ok((r.velocity?.sd ?? 0) > 18);
	assert.match(compareText(r), /Velocity: 40–120/);
});

test("compare: уже сыгранного, чем цели, — лишние ноты и опоздание в мс", () => {
	const goal: PlayNote[] = [{ pitch: 60, start: 0 }];
	const played: PlayNote[] = [{ pitch: 60, start: 0.2 }, { pitch: 62, start: 1 }];
	const r = comparePlay(goal, played, { tempo: 120, tolerance: 1 });
	assert.equal(r.correct.length, 1);
	assert.equal(r.correct[0].offsetMs, 100); // 0.2 доли при 120 BPM = 100 мс
	assert.equal(r.extra.length, 1);
	assert.match(compareText(r), /опоздал/);
});

test("compare: пустая цель и пустая игра не падают", () => {
	const r = comparePlay([], [], opts);
	assert.equal(r.goalCount, 0);
	assert.equal(r.correct.length, 0);
	assert.equal(compareVerdict(r), "нот нет");
	const only = comparePlay(BASS, [], opts);
	assert.equal(only.missing.length, 8);
	assert.equal(only.perfect, false);
});

test("compare: итог одной строкой для свёрнутого экрана", () => {
	const played = BASS.map((n) => ({ ...n, start: n.start + 0.08 })); // 48 мс при 100 BPM
	const r = comparePlay(BASS, played, opts);
	const v = compareVerdict(r);
	assert.match(v, /8 из 8 нот/);
	assert.match(v, /опаздываешь на 48 мс/);
});
