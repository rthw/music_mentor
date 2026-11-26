/**
 * Сборка «записи» ученика для сценария 06 (игра руками).
 *
 * Цель — бас «Ночи» из фикстуры `tests/fixtures/als/12/vm_session_chords.als` (темп 100,
 * 8 нот в 16 долях). Здесь та же партия, сыгранная руками с типичными ошибками новичка:
 *  - начал на 0.5 доли позже (общий сдвиг записи, не ошибка каждой ноты);
 *  - в 4-м такте взял F# вместо F (полтона выше);
 *  - пропустил ноту D2 во 2-м такте;
 *  - живое время ±20 мс в обе стороны.
 *
 * Запуск (путь к .als — аргументом, его делает tools/eval/run.sh):
 *   node tools/eval/fixtures/play/build_recording.ts /tmp/Ночь\ —\ запись.als
 */

import { writeFileSync } from "node:fs";
import { buildAls } from "../../../../tests/alsbuild.ts";

/** Цель: бас «Ночи» — те же ноты, что в tests/fixtures/als/12/vm_session_chords.als. */
const GOAL = [
	{ pitch: 36, start: 0, duration: 3, velocity: 100 }, // C2
	{ pitch: 48, start: 3, duration: 1, velocity: 90 }, // C3
	{ pitch: 31, start: 4, duration: 3, velocity: 100 }, // G1
	{ pitch: 38, start: 7, duration: 1, velocity: 90 }, // D2
	{ pitch: 33, start: 8, duration: 3, velocity: 100 }, // A1
	{ pitch: 45, start: 11, duration: 1, velocity: 90 }, // A2
	{ pitch: 29, start: 12, duration: 3, velocity: 100 }, // F1
	{ pitch: 36, start: 15, duration: 1, velocity: 90 }, // C2
];

const SHIFT = 0.5; // доли: начал на восьмую позже (300 мс при 100 BPM)
const JITTER_MS = [10, -20, 15, 0, -10, 20, 5, -5];
const MS_PER_BEAT = 600; // 100 BPM

const played = GOAL.filter((n) => n.start !== 7).map((n, i) => ({
	pitch: n.start === 12 ? 30 : n.pitch, // F1 -> F#1: полтона выше (частая ошибка)
	start: Math.round((n.start + SHIFT + JITTER_MS[i] / MS_PER_BEAT) * 1000) / 1000,
	duration: n.duration,
	velocity: n.velocity,
}));

const out = process.argv[2];
if (!out) {
	console.error("нужен путь, куда записать .als");
	process.exit(2);
}
writeFileSync(
	out,
	buildAls({
		creator: "Ableton Live 11.3.21",
		tempo: 100,
		tracks: [
			{
				type: "midi",
				name: "Бас (моя запись)",
				devices: ["Operator"],
				clips: [{ name: "Попытка 1", where: "session", start: 0, length: 16, notes: played }],
			},
		],
	}),
);
console.log(`записал ${out}: ${played.length} нот, темп 100`);
