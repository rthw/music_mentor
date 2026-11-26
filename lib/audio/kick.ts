/**
 * Бочка и бас по огибающей полосы 40–120 Гц.
 *
 * Бочка здесь — онсет в этой полосе (резкий рост энергии не меньше чем на 3 дБ). Это честно только
 * когда низ ритмичен: ноты баса тоже дают онсеты, поэтому вердикт выдаём лишь при регулярных ударах
 * (≥ 8 штук, интервалы кратны медианному). Мерим «насколько удар выступает над низом между ударами»:
 * энергия полосы вокруг удара против энергии в середине между ударами. Маленький запас (≤ 4 дБ) значит,
 * что бас по энергии не уступает бочке — они спорят за одну полосу.
 */

import { powToDb } from "./dsp.ts";

export interface KickResult {
	/** Найдено низких онсетов. */
	count: number;
	/** Медианный интервал между ними, мс (0, если меньше двух). */
	intervalMs: number;
	/** Доля интервалов, кратных медианному (регулярность). */
	regularity: number;
	/** Насколько удар выступает над низом между ударами, дБ (медиана). null — не считали. */
	stickOutDb: number | null;
	/** clear — бочка выступает; compete — бас не уступает; ducked — бас уже уходит с удара; unclear — между; none — ударов мало/нерегулярно. */
	verdict: "clear" | "compete" | "ducked" | "unclear" | "none";
	/** На сколько низ проседает рядом с ударом (через 60–100 мс после или за 30–60 мс до) ниже середины между ударами, дБ: бас уже убирается — дакинг. */
	dipDb: number | null;
}

export const KICK_HIT_ISO = { rise: 3, minShare: 0.1, minRegularity: 0.8, minGapMs: 180, minCount: 8, clearDb: 9, duckDb: 5, competeDb: 4.5 };

export function detectKicks(env: Float64Array, dtSec: number): KickResult {
	const n = env.length;
	const none: KickResult = { count: 0, intervalMs: 0, regularity: 0, stickOutDb: null, dipDb: null, verdict: "none" };
	if (n < 20) return none;
	const db = new Float64Array(n);
	let maxDb = -200;
	let maxPow = 0;
	for (let i = 0; i < n; i++) {
		db[i] = powToDb(env[i], -120);
		if (db[i] > maxDb) maxDb = db[i];
		if (env[i] > maxPow) maxPow = env[i];
	}
	// Не ищем в тишине: ниже макс−30 дБ (и ниже −70 дБFS по мощности) это не удар.
	const floorDb = Math.max(maxDb - 30, -70);
	const minGap = Math.max(1, Math.round(KICK_HIT_ISO.minGapMs / 1000 / dtSec));
	const win = Math.max(1, Math.round(0.04 / dtSec)); // 40 мс на подъём
	const pre0 = Math.max(2, Math.round(0.05 / dtSec));
	const pre1 = Math.max(1, Math.round(0.015 / dtSec));
	const peaks: number[] = [];
	let i = pre0;
	while (i < n - win) {
		// Уровень до удара: средняя мощность в окне [i−50 мс, i−15 мс].
		let s = 0;
		let c = 0;
		for (let j = i - pre0; j <= i - pre1; j++) {
			s += env[j];
			c++;
		}
		const prePow = s / c;
		const pre = powToDb(prePow, -120);
		// Нужен и заметный рост в дБ, и заметная прибавка энергии: иначе «биения» бочки и баса
		// (две близкие низкие частоты) дают ложные онсеты на нулях огибающей.
		if (db[i] >= floorDb && db[i] - pre >= KICK_HIT_ISO.rise && env[i] - prePow >= KICK_HIT_ISO.minShare * maxPow) {
			let p = i;
			for (let j = i; j <= i + win && j < n; j++) if (env[j] > env[p]) p = j;
			peaks.push(p);
			i = p + minGap;
		} else i++;
	}
	if (peaks.length < 2) return { ...none, count: peaks.length };
	const gaps: number[] = [];
	for (let k = 1; k < peaks.length; k++) gaps.push(peaks[k] - peaks[k - 1]);
	const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
	const near = gaps.filter((g) => {
		const r = g / med;
		const m = Math.round(r);
		return m >= 1 && Math.abs(r - m) < 0.12 * Math.max(1, m);
	}).length;
	const base: KickResult = { count: peaks.length, intervalMs: Math.round(med * dtSec * 1000), regularity: near / gaps.length, stickOutDb: null, dipDb: null, verdict: "none" };
	if (peaks.length < KICK_HIT_ISO.minCount || base.regularity < KICK_HIT_ISO.minRegularity) return base;

	// Энергия вокруг удара [−5 мс, +45 мс] против середины между ударами.
	const meanPow = (a: number, b: number) => {
		const lo = Math.max(0, Math.min(a, b));
		const hi = Math.min(n - 1, Math.max(a, b));
		let t = 0;
		for (let j = lo; j <= hi; j++) t += env[j];
		return t / (hi - lo + 1);
	};
	const before = Math.round(0.005 / dtSec);
	const after = Math.round(0.045 / dtSec);
	const diffs: number[] = [];
	const dips: number[] = [];
	for (let k = 0; k + 1 < peaks.length; k++) {
		const gap = peaks[k + 1] - peaks[k];
		if (gap > 4 * med) continue;
		const half = Math.max(1, Math.min(Math.round(0.04 / dtSec), Math.floor(gap / 6)));
		const mid = peaks[k] + Math.floor(gap / 2);
		const hit = meanPow(peaks[k] - before, peaks[k] + after);
		const between = meanPow(mid - half, mid + half);
		diffs.push(Math.min(40, powToDb(hit, -120) - powToDb(between, -120)));
		const tail = meanPow(peaks[k] + Math.round(0.06 / dtSec), peaks[k] + Math.min(Math.round(0.1 / dtSec), Math.floor(gap / 2)));
		// Просело после удара (бас убирают на ударе) или до «онсета» (онсет — это возврат баса после просадки).
		const before60 = meanPow(peaks[k] - Math.round(0.06 / dtSec), peaks[k] - Math.round(0.03 / dtSec));
		const lowest = Math.min(tail, before60);
		dips.push(Math.max(-40, Math.min(40, powToDb(between, -120) - powToDb(lowest, -120))));
	}
	if (diffs.length < 4) return base;
	diffs.sort((a, b) => a - b);
	const stick = diffs[Math.floor(diffs.length / 2)];
	dips.sort((a, b) => a - b);
	const dip = dips[Math.floor(dips.length / 2)];
	let verdict: KickResult["verdict"] = stick <= KICK_HIT_ISO.competeDb ? "compete" : stick >= KICK_HIT_ISO.clearDb ? "clear" : "unclear";
	if (verdict !== "clear" && dip >= KICK_HIT_ISO.duckDb) verdict = "ducked";
	return { ...base, stickOutDb: Math.round(stick * 10) / 10, dipDb: Math.round(dip * 10) / 10, verdict };
}
