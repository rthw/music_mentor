/** Сборка wav для тестов и фикстур eval: синтетика с известным ответом, без чужой музыки. */

import { closeSync, openSync, writeSync } from "node:fs";

export interface WavSpec {
	rate?: number;
	bits?: 8 | 16 | 24 | 32 | 64;
	float?: boolean;
	/** Заголовок как у потоковых рендеров: размер data = 0. */
	streamingHeader?: boolean;
	/** Формат WAVE_FORMAT_EXTENSIBLE. */
	extensible?: boolean;
}

export function wavHeader(frames: number, channels: number, spec: WavSpec = {}): Buffer {
	const rate = spec.rate ?? 44100;
	const bits = spec.bits ?? 16;
	const float = spec.float ?? false;
	const align = channels * (bits / 8);
	const dataBytes = frames * align;
	const ext = spec.extensible;
	const fmtLen = ext ? 40 : 16;
	const h = Buffer.alloc(12 + 8 + fmtLen + 8);
	h.write("RIFF", 0, "latin1");
	h.writeUInt32LE(spec.streamingHeader ? 0 : 4 + 8 + fmtLen + 8 + dataBytes, 4);
	h.write("WAVE", 8, "latin1");
	h.write("fmt ", 12, "latin1");
	h.writeUInt32LE(fmtLen, 16);
	h.writeUInt16LE(ext ? 0xfffe : float ? 3 : 1, 20);
	h.writeUInt16LE(channels, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * align, 28);
	h.writeUInt16LE(align, 32);
	h.writeUInt16LE(bits, 34);
	let p = 36;
	if (ext) {
		h.writeUInt16LE(22, p);
		h.writeUInt16LE(bits, p + 2);
		h.writeUInt32LE(channels === 1 ? 4 : 3, p + 4);
		h.writeUInt16LE(float ? 3 : 1, p + 8); // начало GUID подформата
		p += 24;
	}
	h.write("data", p, "latin1");
	h.writeUInt32LE(spec.streamingHeader ? 0 : dataBytes, p + 4);
	return h;
}

/** Кадры → байты: channels[c][i] в диапазоне −1…1 (с насыщением для целых). */
export function encodeFrames(channels: ArrayLike<number>[], from: number, to: number, spec: WavSpec = {}): Buffer {
	const bits = spec.bits ?? 16;
	const float = spec.float ?? false;
	const nch = channels.length;
	const n = to - from;
	const out = Buffer.alloc(n * nch * (bits / 8));
	let p = 0;
	for (let i = from; i < to; i++) {
		for (let c = 0; c < nch; c++) {
			const x = Math.max(-1, Math.min(1, channels[c][i]));
			if (float && bits === 32) p = out.writeFloatLE(channels[c][i], p);
			else if (float) p = out.writeDoubleLE(channels[c][i], p);
			else if (bits === 8) p = out.writeUInt8(Math.round(x * 127) + 128, p);
			else if (bits === 16) p = out.writeInt16LE(Math.round(x * 32767), p);
			else if (bits === 24) {
				const v = Math.round(x * 8388607);
				out[p++] = v & 0xff;
				out[p++] = (v >> 8) & 0xff;
				out[p++] = (v >> 16) & 0xff;
			} else p = out.writeInt32LE(Math.round(x * 2147483647), p);
		}
	}
	return out;
}

export function writeWav(file: string, channels: ArrayLike<number>[], spec: WavSpec = {}): void {
	const frames = channels[0].length;
	const fd = openSync(file, "w");
	try {
		writeSync(fd, wavHeader(frames, channels.length, spec));
		const step = 1 << 16;
		for (let i = 0; i < frames; i += step) writeSync(fd, encodeFrames(channels, i, Math.min(frames, i + step), spec));
	} finally {
		closeSync(fd);
	}
}

/** Тот же кусок `times` раз подряд (длинный файл без гигантских массивов в памяти). */
export function writeWavRepeated(file: string, channels: ArrayLike<number>[], times: number, spec: WavSpec = {}): void {
	const frames = channels[0].length;
	const fd = openSync(file, "w");
	try {
		writeSync(fd, wavHeader(frames * times, channels.length, spec));
		const chunk = encodeFrames(channels, 0, frames, spec);
		for (let t = 0; t < times; t++) writeSync(fd, chunk);
	} finally {
		closeSync(fd);
	}
}

// --- генераторы -------------------------------------------------------------------------

export const dbToAmp = (db: number) => Math.pow(10, db / 20);

export function sine(rate: number, seconds: number, freq: number, amp: number): Float32Array {
	const n = Math.round(rate * seconds);
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
	return a;
}

/** Детерминированный генератор (mulberry32): тесты не должны зависеть от случая. */
export function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Розовый шум (Пол Келле), пик нормирован до `peak`. */
export function pinkNoise(rate: number, seconds: number, peak: number, seed = 1): Float32Array {
	const r = rng(seed);
	const n = Math.round(rate * seconds);
	const a = new Float32Array(n);
	let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
	let max = 0;
	for (let i = 0; i < n; i++) {
		const w = r() * 2 - 1;
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.969 * b2 + w * 0.153852;
		b3 = 0.8665 * b3 + w * 0.3104856;
		b4 = 0.55 * b4 + w * 0.5329522;
		b5 = -0.7616 * b5 - w * 0.016898;
		const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
		b6 = w * 0.115926;
		a[i] = v;
		if (Math.abs(v) > max) max = Math.abs(v);
	}
	for (let i = 0; i < n; i++) a[i] = (a[i] / max) * peak;
	return a;
}

export interface LoopSpec {
	rate?: number;
	seconds: number;
	bpm: number;
	/** Амплитуда бочки (пик). */
	kick: number;
	/** Амплитуда баса: непрерывная синусоида bassHz. 0 — баса нет. */
	bass: number;
	bassHz?: number;
	/** Бас замолкает на время удара и чуть после (сайдчейн «вручную»). */
	duck?: boolean;
	/** Шум сверху (хэты-имитация), амплитуда. */
	hat?: number;
	seed?: number;
}

/** Четыре четверти: бочка (синус с падением 150→50 Гц, затухание ~60 мс) + бас. Моно. */
export function kickBassLoop(s: LoopSpec): Float32Array {
	const rate = s.rate ?? 44100;
	const n = Math.round(rate * s.seconds);
	const out = new Float32Array(n);
	const beat = Math.round((rate * 60) / s.bpm);
	const bassHz = s.bassHz ?? 55;
	const duckLen = Math.round(0.12 * rate);
	const r = rng(s.seed ?? 7);
	for (let t = 0; t < n; t += beat) {
		const len = Math.min(Math.round(0.35 * rate), n - t);
		let ph = 0;
		for (let i = 0; i < len; i++) {
			const tt = i / rate;
			const f = 50 + 100 * Math.exp(-tt / 0.02);
			ph += (2 * Math.PI * f) / rate;
			out[t + i] += s.kick * Math.exp(-tt / 0.06) * Math.sin(ph);
		}
	}
	if (s.bass > 0) {
		for (let i = 0; i < n; i++) {
			if (s.duck && i % beat < duckLen) continue;
			out[i] += s.bass * Math.sin((2 * Math.PI * bassHz * i) / rate);
		}
	}
	if (s.hat) for (let i = 0; i < n; i++) out[i] += s.hat * (r() * 2 - 1);
	return out;
}
