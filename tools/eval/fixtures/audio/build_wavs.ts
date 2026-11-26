/**
 * Фикстура сценария 08 (звук): два сгенерированных wav, чужой музыки нет.
 *
 *  - «Ночь — экспорт.wav» — «мутный» трек ученика, 100 BPM: бас громкий и непрерывный (спорит с бочкой),
 *    густой «пэд» на 250–400 Гц, верха почти нет.
 *  - «Референс.wav» — тот же темп: бочка выступает над тихим басом, пэд убран, есть верха; громче.
 *
 * Запуск: node tools/eval/fixtures/audio/build_wavs.ts <папка>
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { kickBassLoop, pinkNoise, writeWav } from "../../../../tests/wavbuild.ts";

const RATE = 44100;
const SECONDS = 48;
const BPM = 100;

function pad(freqs: number[], amp: number, seconds: number): Float32Array {
	const n = Math.round(RATE * seconds);
	const out = new Float32Array(n);
	for (const f of freqs) for (let i = 0; i < n; i++) out[i] += (amp / freqs.length) * Math.sin((2 * Math.PI * f * i) / RATE);
	return out;
}

/** Высокие: дифференцированный шум (грубый high-pass), в такт — как хэты на 8-х. */
function hats(seconds: number, amp: number, seed: number): Float32Array {
	const n = Math.round(RATE * seconds);
	const noise = pinkNoise(RATE, seconds, 1, seed);
	const out = new Float32Array(n);
	const step = Math.round((RATE * 60) / BPM / 2);
	for (let i = 1; i < n; i++) {
		const env = Math.exp(-((i % step) / RATE) / 0.03);
		out[i] = amp * env * (noise[i] - noise[i - 1]);
	}
	return out;
}

function mix(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts[0].length);
	for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i];
	return out;
}

function gain(a: Float32Array, g: number): Float32Array {
	return a.map((v) => v * g);
}

const dir = process.argv[2];
if (!dir) {
	console.error("Использование: build_wavs.ts <папка>");
	process.exit(2);
}
mkdirSync(dir, { recursive: true });

// Свой: бас 0.45 непрерывный, пэд 280–380 Гц, верха нет.
const own = mix(kickBassLoop({ rate: RATE, seconds: SECONDS, bpm: BPM, kick: 0.45, bass: 0.4, bassHz: 53.7 }), pad([280, 310, 350, 380], 0.28, SECONDS), pinkNoise(RATE, SECONDS, 0.12, 5), hats(SECONDS, 0.04, 2));
const ownR = mix(own, pad([300], 0.04, SECONDS)); // чуть другой правый канал — не чистое моно
writeWav(path.join(dir, "Ночь — экспорт.wav"), [gain(own, 0.75), gain(ownR, 0.75)], { rate: RATE, bits: 24 });

// Референс: бас 0.15, пэд тише и выше, хэты заметные; громче по общему уровню.
const ref = mix(kickBassLoop({ rate: RATE, seconds: SECONDS, bpm: BPM, kick: 0.7, bass: 0.15, bassHz: 53.7 }), pad([600, 900, 1500], 0.1, SECONDS), pinkNoise(RATE, SECONDS, 0.12, 6), hats(SECONDS, 0.25, 3));
writeWav(path.join(dir, "Референс.wav"), [ref, mix(ref, pad([700], 0.05, SECONDS))], { rate: RATE, bits: 24 });
console.log("готово:", dir);
