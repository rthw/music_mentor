/** Фильтры и мелкая арифметика для анализа звука. */

export class Biquad {
	private z1 = 0;
	private z2 = 0;
	private b0: number;
	private b1: number;
	private b2: number;
	private a1: number;
	private a2: number;
	constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
		this.b0 = b0;
		this.b1 = b1;
		this.b2 = b2;
		this.a1 = a1;
		this.a2 = a2;
	}

	/** dst[i] = фильтр(src[i]), i < n. src и dst могут быть одним массивом. */
	run(src: ArrayLike<number>, dst: Float64Array, n: number): void {
		const { b0, b1, b2, a1, a2 } = this;
		let z1 = this.z1;
		let z2 = this.z2;
		for (let i = 0; i < n; i++) {
			const x = src[i];
			const y = b0 * x + z1;
			z1 = b1 * x - a1 * y + z2;
			z2 = b2 * x - a2 * y;
			dst[i] = y;
		}
		this.z1 = z1;
		this.z2 = z2;
	}
}

/** Фильтр высоких частот 2-го порядка (билинейное преобразование), Q — добротность. */
export function highpass(fs: number, f0: number, q = Math.SQRT1_2): Biquad {
	const k = Math.tan((Math.PI * f0) / fs);
	const norm = 1 / (1 + k / q + k * k);
	return new Biquad(norm, -2 * norm, norm, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm);
}

/** Фильтр низких частот 2-го порядка. */
export function lowpass(fs: number, f0: number, q = Math.SQRT1_2): Biquad {
	const k = Math.tan((Math.PI * f0) / fs);
	const norm = 1 / (1 + k / q + k * k);
	return new Biquad(k * k * norm, 2 * k * k * norm, k * k * norm, 2 * (k * k - 1) * norm, (1 - k / q + k * k) * norm);
}

/** K-взвешивание ITU-R BS.1770-4: высокочастотная «полка» (ступень 1) и RLB-высокочастотный фильтр (ступень 2). */
export function kWeighting(fs: number): [Biquad, Biquad] {
	const f1 = 1681.974450955533;
	const g = 3.999843853973347;
	const q1 = 0.7071752369554196;
	const k1 = Math.tan((Math.PI * f1) / fs);
	const vh = Math.pow(10, g / 20);
	const vb = Math.pow(vh, 0.4996667741545416);
	const a0 = 1 + k1 / q1 + k1 * k1;
	const shelf = new Biquad(
		(vh + (vb * k1) / q1 + k1 * k1) / a0,
		(2 * (k1 * k1 - vh)) / a0,
		(vh - (vb * k1) / q1 + k1 * k1) / a0,
		(2 * (k1 * k1 - 1)) / a0,
		(1 - k1 / q1 + k1 * k1) / a0,
	);
	return [shelf, highpass(fs, 38.13547087602444, 0.5003270373238773)];
}

/**
 * Истинный пик (приближённо): 4-кратная передискретизация оконным sinc из 12 отсчётов на фазу.
 * Чтобы не считать 3 фазы × 12 отсчётов на каждый сэмпл (10 минут стерео — десятки секунд),
 * интерполяция идёт только возле сэмплов не тише 0.6 текущего максимума: перепик между
 * отсчётами бывает только рядом с большими значениями.
 */
export class TruePeak {
	private static readonly L = 6;
	private static taps: Float64Array[] = (() => {
		const L = TruePeak.L;
		return [1, 2, 3].map((p) => {
			const f = p / 4;
			const h = new Float64Array(2 * L);
			for (let j = -L + 1; j <= L; j++) {
				const t = j - f;
				const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
				const w = Math.abs(t) < L ? 0.5 * (1 + Math.cos((Math.PI * t) / L)) : 0;
				h[j + L - 1] = sinc * w;
			}
			return h;
		});
	})();

	private tail = new Float32Array(2 * TruePeak.L - 1);
	/** Сэмплпик и истинный пик (линейно, 0…). */
	samplePeak = 0;
	peak = 0;

	push(x: Float32Array): void {
		const L = TruePeak.L;
		const ext = new Float32Array(this.tail.length + x.length);
		ext.set(this.tail, 0);
		ext.set(x, this.tail.length);
		for (let i = 0; i < x.length; i++) {
			const a = Math.abs(x[i]);
			if (a > this.samplePeak) this.samplePeak = a;
		}
		if (this.samplePeak > this.peak) this.peak = this.samplePeak;
		const [h1, h2, h3] = TruePeak.taps;
		const last = ext.length - L - 1;
		for (let i = L - 1; i <= last; i++) {
			const m = Math.max(Math.abs(ext[i]), Math.abs(ext[i + 1]));
			if (m < 0.6 * this.peak || m === 0) continue;
			let s1 = 0;
			let s2 = 0;
			let s3 = 0;
			const base = i - L + 1;
			for (let j = 0; j < 2 * L; j++) {
				const v = ext[base + j];
				s1 += v * h1[j];
				s2 += v * h2[j];
				s3 += v * h3[j];
			}
			const p = Math.max(Math.abs(s1), Math.abs(s2), Math.abs(s3));
			if (p > this.peak) this.peak = p;
		}
		this.tail = ext.slice(ext.length - (2 * L - 1));
	}
}

export const toDb = (x: number, floor = -120) => (x > 0 ? Math.max(floor, 20 * Math.log10(x)) : floor);
export const powToDb = (p: number, floor = -120) => (p > 0 ? Math.max(floor, 10 * Math.log10(p)) : floor);
/** LUFS из средней квадратичной энергии K-взвешенного сигнала (сумма по каналам). */
export const lufsOf = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);
