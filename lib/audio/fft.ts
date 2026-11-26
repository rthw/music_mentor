/** Комплексный БПФ по основанию 2 (на месте). Таблицы считаются один раз на размер. */

export class FFT {
	readonly n: number;
	private cos: Float64Array;
	private sin: Float64Array;
	private rev: Uint32Array;

	constructor(n: number) {
		if (n < 2 || (n & (n - 1)) !== 0) throw new Error("Размер БПФ — степень двойки");
		this.n = n;
		this.cos = new Float64Array(n / 2);
		this.sin = new Float64Array(n / 2);
		for (let i = 0; i < n / 2; i++) {
			this.cos[i] = Math.cos((2 * Math.PI * i) / n);
			this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
		}
		this.rev = new Uint32Array(n);
		const bits = Math.log2(n);
		for (let i = 0; i < n; i++) {
			let r = 0;
			for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
			this.rev[i] = r;
		}
	}

	transform(re: Float64Array, im: Float64Array): void {
		const n = this.n;
		const rev = this.rev;
		for (let i = 0; i < n; i++) {
			const j = rev[i];
			if (j > i) {
				let t = re[i];
				re[i] = re[j];
				re[j] = t;
				t = im[i];
				im[i] = im[j];
				im[j] = t;
			}
		}
		for (let size = 2; size <= n; size <<= 1) {
			const half = size >> 1;
			const step = n / size;
			for (let start = 0; start < n; start += size) {
				for (let k = 0, t = 0; k < half; k++, t += step) {
					const a = start + k;
					const b = a + half;
					const wr = this.cos[t];
					const wi = this.sin[t];
					const xr = re[b] * wr - im[b] * wi;
					const xi = re[b] * wi + im[b] * wr;
					re[b] = re[a] - xr;
					im[b] = im[a] - xi;
					re[a] += xr;
					im[a] += xi;
				}
			}
		}
	}
}
