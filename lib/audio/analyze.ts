/**
 * Анализ wav: громкость (BS.1770), полосы, стерео, динамика, громкость по блокам, бочка и бас.
 * Один проход по файлу кусками — память не растёт с длиной трека.
 */

import { FFT } from "./fft.ts";
import { highpass, kWeighting, lowpass, lufsOf, powToDb, toDb, TruePeak } from "./dsp.ts";
import { detectKicks, type KickResult } from "./kick.ts";
import { readWavInfo, wavBlocks, type WavInfo } from "./wav.ts";

export interface BandDef {
	id: "sub" | "low" | "lowmid" | "mid" | "high" | "air";
	name: string;
	range: string;
	lo: number;
	hi: number;
}

export const BANDS: BandDef[] = [
	{ id: "sub", name: "саб", range: "<60 Гц", lo: 0, hi: 60 },
	{ id: "low", name: "низ", range: "60–250 Гц", lo: 60, hi: 250 },
	{ id: "lowmid", name: "низкая середина", range: "250–500 Гц", lo: 250, hi: 500 },
	{ id: "mid", name: "середина", range: "0.5–2 кГц", lo: 500, hi: 2000 },
	{ id: "high", name: "верх", range: "2–8 кГц", lo: 2000, hi: 8000 },
	{ id: "air", name: "воздух", range: ">8 кГц", lo: 8000, hi: Infinity },
];

export interface AudioAnalysis {
	path: string;
	info: Pick<WavInfo, "channels" | "used" | "sampleRate" | "bits" | "format" | "frames" | "duration">;
	loudness: {
		integrated: number;
		shortTermMax: number;
		truePeak: number;
		samplePeak: number;
		lra: number;
		/** Громкий кусок был, но интегральную посчитать не вышло (тишина). */
		silent: boolean;
	};
	dynamics: { crest: number; rmsDb: number; plr: number };
	/** Уровень полосы относительно общей энергии, дБ (по порядку BANDS). */
	bands: number[];
	/** Энергия ниже 50 Гц относительно общей, дБ. */
	below50: number;
	stereo: null | {
		correlation: number;
		/** Доля энергии «стороны» (L−R) по полосам, % (по порядку BANDS). */
		width: number[];
		widthTotal: number;
		/** Корреляция ниже 120 Гц. */
		lowCorrelation: number;
		/** Насколько проседает громкость ниже 120 Гц при сложении в моно, дБ (≤ 0). */
		lowMonoLoss: number;
	};
	/** Громкость по блокам из bars тактов, LUFS (без гейтинга). */
	blocks: null | { bars: number; tempo: number; beatsPerBar: number; seconds: number; lufs: number[] };
	kick: KickResult;
	/** Сколько секунд заняло. */
	seconds: number;
}

export interface AnalyzeOptions {
	tempo?: number;
	beatsPerBar?: number;
	/** Такты в блоке громкости (по умолчанию 8). */
	blockBars?: number;
}

const FFT_N = 4096;

export function analyzeWav(path: string, opts: AnalyzeOptions = {}): AudioAnalysis {
	const t0 = Date.now();
	const info = readWavInfo(path);
	const fs = info.sampleRate;
	const nch = info.used;
	const stereo = nch === 2;

	// --- громкость ---
	const kL = kWeighting(fs);
	const kR = stereo ? kWeighting(fs) : null;
	const subLen = Math.round(0.1 * fs);
	const subs: number[] = [];
	let subAcc = 0;
	let subN = 0;
	let partialAcc = 0;
	let partialN = 0;
	const tempo = opts.tempo && opts.tempo > 20 && opts.tempo < 400 ? opts.tempo : undefined;
	const bpb = opts.beatsPerBar && opts.beatsPerBar > 0 ? opts.beatsPerBar : 4;
	const blockBars = opts.blockBars && opts.blockBars > 0 ? opts.blockBars : 8;
	const blockLen = tempo ? ((blockBars * bpb * 60) / tempo) * fs : 0;
	const blockSums: number[] = [];
	let framePos = 0;

	// --- динамика и стерео во времени ---
	let sumL = 0;
	let sumR = 0;
	let sumLR = 0;
	const tp = [new TruePeak(), new TruePeak()];

	// --- бочка: полоса 40–120 Гц, огибающая по 5 мс ---
	const kickHp = highpass(fs, 40);
	const kickLp1 = lowpass(fs, 120);
	const kickLp2 = lowpass(fs, 120);
	const envLen = Math.max(1, Math.round(0.005 * fs));
	const env: number[] = [];
	let envAcc = 0;
	let envN = 0;

	// --- спектр: Welch по 4096, 50% перекрытия; L и R одним комплексным БПФ ---
	const fft = new FFT(FFT_N);
	const hop = FFT_N / 2;
	const win = new Float64Array(FFT_N);
	for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
	const re = new Float64Array(FFT_N);
	const im = new Float64Array(FFT_N);
	const bufL = new Float32Array(FFT_N);
	const bufR = new Float32Array(FFT_N);
	let fill = 0;
	const half = FFT_N / 2;
	const pl = new Float64Array(half + 1);
	const pr = new Float64Array(half + 1);
	const cr = new Float64Array(half + 1);
	let frames = 0;
	const gateFramePower = Math.pow(10, -70 / 10); // тише −70 дБFS — пауза, в полосы не идёт

	const processFrame = () => {
		let e = 0;
		for (let i = 0; i < FFT_N; i++) {
			const l = bufL[i];
			const r = stereo ? bufR[i] : 0;
			e += l * l + r * r;
			re[i] = l * win[i];
			im[i] = r * win[i];
		}
		if (e / FFT_N / nch < gateFramePower) return;
		fft.transform(re, im);
		frames++;
		for (let k = 1; k <= half; k++) {
			const k2 = (FFT_N - k) & (FFT_N - 1);
			// L = (Z[k] + conj Z[N−k]) / 2, R = (Z[k] − conj Z[N−k]) / 2i
			const lr = (re[k] + re[k2]) / 2;
			const li = (im[k] - im[k2]) / 2;
			const rr = (im[k] + im[k2]) / 2;
			const ri = (re[k2] - re[k]) / 2;
			pl[k] += lr * lr + li * li;
			if (stereo) {
				pr[k] += rr * rr + ri * ri;
				cr[k] += lr * rr + li * ri;
			}
		}
	};

	const kw = new Float64Array(32768);
	const tmp = new Float64Array(32768);
	const kwR = new Float64Array(32768);
	const mono = new Float64Array(32768);

	for (const ch of wavBlocks(path, info)) {
		const L = ch[0];
		const R = stereo ? ch[1] : null;
		const n = L.length;

		for (let i = 0; i < n; i++) {
			const l = L[i];
			sumL += l * l;
			if (R) {
				const r = R[i];
				sumR += r * r;
				sumLR += l * r;
			}
		}
		tp[0].push(L);
		if (R) tp[1].push(R);

		// K-взвешенная мощность (сумма по каналам) в окна 100 мс и в блоки по тактам.
		kL[0].run(L, tmp, n);
		kL[1].run(tmp, kw, n);
		if (R && kR) {
			kR[0].run(R, tmp, n);
			kR[1].run(tmp, kwR, n);
		}
		for (let i = 0; i < n; i++) {
			const pw = R ? kw[i] * kw[i] + kwR[i] * kwR[i] : kw[i] * kw[i];
			subAcc += pw;
			if (++subN === subLen) {
				subs.push(subAcc / subLen);
				subAcc = 0;
				subN = 0;
			}
			if (blockLen) {
				const b = Math.floor((framePos + i) / blockLen);
				blockSums[b] = (blockSums[b] ?? 0) + pw;
			}
		}
		partialAcc = subAcc;
		partialN = subN;

		// Низ для бочки: моно → 40–120 Гц → квадрат → 5 мс.
		for (let i = 0; i < n; i++) mono[i] = R ? (L[i] + R[i]) * 0.5 : L[i];
		kickHp.run(mono, tmp, n);
		kickLp1.run(tmp, tmp, n);
		kickLp2.run(tmp, tmp, n);
		for (let i = 0; i < n; i++) {
			envAcc += tmp[i] * tmp[i];
			if (++envN === envLen) {
				env.push(envAcc / envLen);
				envAcc = 0;
				envN = 0;
			}
		}

		// Спектр.
		for (let i = 0; i < n; i++) {
			bufL[fill] = L[i];
			if (R) bufR[fill] = R[i];
			if (++fill === FFT_N) {
				processFrame();
				bufL.copyWithin(0, hop);
				bufR.copyWithin(0, hop);
				fill = FFT_N - hop;
			}
		}
		framePos += n;
	}
	// Короткий файл: ни одного полного кадра — добиваем нулями и считаем один раз.
	if (frames === 0 && fill > 0) {
		bufL.fill(0, fill);
		bufR.fill(0, fill);
		processFrame();
	}

	// --- итоговая громкость ---
	const loud = computeLoudness(subs, partialAcc, partialN);
	const samplePeak = Math.max(tp[0].samplePeak, tp[1].samplePeak);
	const truePeak = Math.max(tp[0].peak, tp[1].peak);
	const N = info.frames;
	const rms = Math.sqrt((sumL + sumR) / (N * nch));
	const rmsDb = toDb(rms);
	const samplePeakDb = toDb(samplePeak);

	// --- полосы ---
	const binHz = fs / FFT_N;
	const bandP = BANDS.map(() => 0);
	const bandS = BANDS.map(() => 0);
	const bandC = BANDS.map(() => 0);
	const bandL = BANDS.map(() => 0);
	const bandR = BANDS.map(() => 0);
	let total = 0;
	let below50 = 0;
	let lowL = 0;
	let lowR = 0;
	let lowC = 0;
	for (let k = 1; k <= half; k++) {
		const f = k * binHz;
		const p = pl[k] + pr[k];
		total += p;
		if (f < 50) below50 += p;
		if (f < 120) {
			lowL += pl[k];
			lowR += pr[k];
			lowC += cr[k];
		}
		const b = BANDS.findIndex((x) => f >= x.lo && f < x.hi);
		bandP[b] += p;
		bandL[b] += pl[k];
		bandR[b] += pr[k];
		bandC[b] += cr[k];
		bandS[b] += (pl[k] + pr[k] - 2 * cr[k]) / 4;
	}
	const bands = bandP.map((p) => (total > 0 && p > 0 ? Math.round(powToDb(p / total) * 10) / 10 : -99));

	let st: AudioAnalysis["stereo"] = null;
	if (stereo) {
		const width = BANDS.map((_, b) => {
			const side = bandS[b];
			const mid = (bandL[b] + bandR[b] + 2 * bandC[b]) / 4;
			return side + mid > 0 ? Math.round((100 * side) / (side + mid)) : 0;
		});
		const totS = bandS.reduce((a, b) => a + b, 0);
		const totM = bandL.reduce((a, b, i) => a + b + bandR[i] + 2 * bandC[i], 0) / 4;
		const lowS = (lowL + lowR - 2 * lowC) / 4;
		const lowM = (lowL + lowR + 2 * lowC) / 4;
		const corr = (c: number, a: number, b: number) => (a > 0 && b > 0 ? c / Math.sqrt(a * b) : 1);
		st = {
			correlation: round(corr(sumLR, sumL, sumR), 2),
			width,
			widthTotal: totS + totM > 0 ? Math.round((100 * totS) / (totS + totM)) : 0,
			lowCorrelation: round(corr(lowC, lowL, lowR), 2),
			lowMonoLoss: lowM + lowS > 0 ? round(powToDb(lowM / (lowM + lowS)), 1) : 0,
		};
	}

	const blocks =
		tempo && blockSums.length
			? {
					bars: blockBars,
					tempo,
					beatsPerBar: bpb,
					seconds: blockLen / fs,
					lufs: blockSums.map((s, i) => {
						const last = i === blockSums.length - 1;
						const len = last ? N - Math.floor(i * blockLen) : blockLen;
						return round(lufsOf(s / Math.max(1, len)), 1);
					}),
				}
			: null;

	return {
		path,
		info: { channels: info.channels, used: info.used, sampleRate: fs, bits: info.bits, format: info.format, frames: N, duration: info.duration },
		loudness: {
			integrated: round(loud.integrated, 1),
			shortTermMax: round(loud.shortTermMax, 1),
			truePeak: round(toDb(truePeak), 1),
			samplePeak: round(samplePeakDb, 1),
			lra: round(loud.lra, 1),
			silent: loud.silent,
		},
		dynamics: { crest: round(samplePeakDb - rmsDb, 1), rmsDb: round(rmsDb, 1), plr: round(toDb(truePeak) - loud.integrated, 1) },
		bands,
		below50: total > 0 && below50 > 0 ? round(powToDb(below50 / total), 1) : -99,
		stereo: st,
		blocks,
		kick: detectKicks(Float64Array.from(env), (envLen / fs)),
		seconds: round((Date.now() - t0) / 1000, 2),
	};
}

const round = (x: number, d: number) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** Интегральная, short-term max и LRA по BS.1770-4 / EBU R128 из окон по 100 мс (мощность). */
function computeLoudness(subs: number[], partialAcc: number, partialN: number) {
	const silent = { integrated: -Infinity, shortTermMax: -Infinity, lra: 0, silent: true };
	const s = subs.slice();
	// Короче 400 мс — один блок из того, что есть.
	if (s.length < 4) {
		const ms = s.length ? s.reduce((x, y) => x + y, 0) / s.length : partialN ? partialAcc / partialN : 0;
		const l = lufsOf(ms);
		return { integrated: l, shortTermMax: l, lra: 0, silent: !(l > -70) };
	}
	const mom: number[] = [];
	for (let i = 0; i + 4 <= s.length; i++) mom.push((s[i] + s[i + 1] + s[i + 2] + s[i + 3]) / 4);
	const abs = mom.filter((m) => lufsOf(m) > -70);
	if (!abs.length) return silent;
	const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
	const rel = lufsOf(mean(abs)) - 10;
	const gated = abs.filter((m) => lufsOf(m) > rel);
	const integrated = lufsOf(mean(gated.length ? gated : abs));

	// Short-term: окна 3 с (30 подблоков), шаг 100 мс; LRA — шаг 1 с.
	let shortMax = -Infinity;
	const st: number[] = [];
	if (s.length >= 30) {
		let run = 0;
		for (let i = 0; i < 30; i++) run += s[i];
		for (let i = 0; ; i++) {
			const l = lufsOf(run / 30);
			if (l > shortMax) shortMax = l;
			if (i % 10 === 0) st.push(l);
			if (i + 30 >= s.length) break;
			run += s[i + 30] - s[i];
		}
	} else {
		shortMax = lufsOf(mean(s));
		st.push(shortMax);
	}
	const stAbs = st.filter((l) => l > -70);
	let lra = 0;
	if (stAbs.length >= 2) {
		const relSt = lufsOf(mean(stAbs.map((l) => Math.pow(10, (l + 0.691) / 10)))) - 20;
		const kept = stAbs.filter((l) => l > relSt).sort((a, b) => a - b);
		if (kept.length >= 2) {
			const q = (p: number) => kept[Math.min(kept.length - 1, Math.round(p * (kept.length - 1)))];
			lra = q(0.95) - q(0.1);
		}
	}
	return { integrated, shortTermMax: shortMax, lra, silent: false };
}
