import assert from "node:assert/strict";
import { mkdirSync, truncateSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import "./stubs/packages.ts";
import { analyzeWav } from "../lib/audio/analyze.ts";
import { compareAnalyses } from "../lib/audio/compare.ts";
import { findWavs } from "../lib/audio/files.ts";
import { FFT } from "../lib/audio/fft.ts";
import { summarizeAnalysis, SUMMARY_LIMIT } from "../lib/audio/summary.ts";
import { readWavInfo, WavError } from "../lib/audio/wav.ts";
import { dbToAmp, kickBassLoop, pinkNoise, sine, writeWav, writeWavRepeated } from "./wavbuild.ts";

const dir = mkdtempSync(path.join(tmpdir(), "mm_audio_"));
after(() => rmSync(dir, { recursive: true, force: true }));
const f = (name: string) => path.join(dir, name);
const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ожидал ${b} ±${tol}, получил ${a}`);

// --- WAV: форматы ------------------------------------------------------------------------

test("wav: синус -20 dBFS в стерео — -20 LUFS (BS.1770), true peak -20, crest 3 дБ", () => {
	const s = sine(48000, 12, 1000, dbToAmp(-20));
	writeWav(f("sine.wav"), [s, s], { rate: 48000, bits: 24 });
	const a = analyzeWav(f("sine.wav"));
	near(a.loudness.integrated, -20, 0.5, "LUFS");
	near(a.loudness.shortTermMax, -20, 0.5, "short-term");
	near(a.loudness.truePeak, -20, 0.5, "true peak");
	near(a.dynamics.crest, 3, 0.3, "crest синуса");
	near(a.loudness.lra, 0, 0.3, "LRA");
	assert.equal(a.info.bits, 24);
	assert.equal(a.info.sampleRate, 48000);
});

test("wav: 16 бит, 24 бита, 32 бита, float32, float64 дают одну и ту же громкость", () => {
	const s = sine(44100, 6, 1000, dbToAmp(-14));
	const got: number[] = [];
	for (const spec of [{ bits: 16 }, { bits: 24 }, { bits: 32 }, { bits: 32, float: true }, { bits: 64, float: true }, { bits: 24, extensible: true }] as const) {
		const file = f(`fmt_${spec.bits}_${"float" in spec ? "f" : "i"}_${"extensible" in spec ? "x" : ""}.wav`);
		writeWav(file, [s, s], spec);
		const info = readWavInfo(file);
		assert.equal(info.bits, spec.bits);
		assert.equal(info.format, "float" in spec ? "float" : "int");
		got.push(analyzeWav(file).loudness.integrated);
	}
	for (const g of got) near(g, -14, 0.5, "LUFS в любом формате");
});

test("wav: моно читается как один канал — без стерео-цифр; 8 бит тоже", () => {
	const s = sine(44100, 6, 1000, dbToAmp(-20));
	writeWav(f("mono.wav"), [s], { bits: 16 });
	const a = analyzeWav(f("mono.wav"));
	assert.equal(a.stereo, null);
	assert.equal(a.info.channels, 1);
	// BS.1770 буквально: один канал, -20 dBFS даёт -23 LUFS.
	near(a.loudness.integrated, -23, 0.5, "моно");
	writeWav(f("m8.wav"), [s], { bits: 8 });
	near(analyzeWav(f("m8.wav")).loudness.integrated, -23, 0.7, "8 бит");
});

test("wav: размер data = 0 (потоковый рендер) — читаем до конца файла", () => {
	const s = sine(44100, 4, 1000, dbToAmp(-20));
	writeWav(f("stream.wav"), [s, s], { streamingHeader: true });
	const info = readWavInfo(f("stream.wav"));
	assert.equal(info.frames, s.length);
});

test("wav: больше двух каналов — берём первые два", () => {
	const s = sine(44100, 3, 1000, dbToAmp(-20));
	writeWav(f("six.wav"), [s, s, s, s, s, s], {});
	const info = readWavInfo(f("six.wav"));
	assert.equal(info.channels, 6);
	assert.equal(info.used, 2);
	near(analyzeWav(f("six.wav")).loudness.integrated, -20, 0.5);
});

test("wav: mp3, мусор и пустой файл — понятная ошибка с тем, как получить wav", () => {
	writeFileSync(f("a.mp3"), Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)]));
	assert.throws(() => readWavInfo(f("a.mp3")), (e: Error) => e instanceof WavError && /mp3/.test(e.message) && /Export Audio\/Video/.test(e.message));
	writeFileSync(f("junk.wav"), Buffer.from("hello, world, this is not audio"));
	assert.throws(() => readWavInfo(f("junk.wav")), (e: Error) => e instanceof WavError && /не похож на wav/.test(e.message));
	writeFileSync(f("empty.wav"), Buffer.alloc(0));
	assert.throws(() => readWavInfo(f("empty.wav")), WavError);
});

test("wav: обрезанный файл (заголовок обещает больше, чем есть) читается по тому, что есть", () => {
	const s = sine(44100, 4, 1000, dbToAmp(-20));
	writeWav(f("cut.wav"), [s, s], {});
	truncateSync(f("cut.wav"), 44 + 44100 * 4); // 1 с из 4 (стерео 16 бит = 4 байта на кадр)
	const info = readWavInfo(f("cut.wav"));
	assert.equal(info.frames, 44100);
	near(analyzeWav(f("cut.wav")).loudness.integrated, -20, 0.6);
});

test("fft: синус попадает в свой бин", () => {
	const n = 1024;
	const fft = new FFT(n);
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
	fft.transform(re, im);
	let best = 0;
	for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
	assert.equal(best, 37);
	near(Math.hypot(re[37], im[37]), n / 2, 1e-6);
});

// --- громкость ---------------------------------------------------------------------------

test("громкость: гейтинг — тишина и пауза не тянут интегральную вниз", () => {
	const rate = 44100;
	const tone = sine(rate, 10, 1000, dbToAmp(-20));
	const loud = new Float32Array(rate * 30);
	loud.set(tone, 0);
	loud.set(tone, rate * 20); // 10 с тона, 10 с тишины, 10 с тона
	writeWav(f("gated.wav"), [loud, loud], {});
	const a = analyzeWav(f("gated.wav"));
	near(a.loudness.integrated, -20, 0.6, "интегральная с гейтингом");
});

test("громкость: LRA растёт, когда громкие и тихие части разные", () => {
	const rate = 44100;
	const quiet = sine(rate, 20, 1000, dbToAmp(-40));
	const loud = sine(rate, 20, 1000, dbToAmp(-20));
	const both = new Float32Array(rate * 40);
	both.set(quiet, 0);
	both.set(loud, rate * 20);
	writeWav(f("lra.wav"), [both, both], {});
	const a = analyzeWav(f("lra.wav"));
	near(a.loudness.lra, 20, 2.5, "LRA 20 LU");
	near(a.loudness.shortTermMax, -20, 0.6);
});

test("громкость: true peak выше сэмпл-пика на межсэмпловом пике", () => {
	// Синус fs/4 со сдвигом по фазе 45°: сэмплы ±0.707·A, настоящий пик A.
	const rate = 44100;
	const n = rate * 2;
	const x = new Float32Array(n);
	for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin((2 * Math.PI * (rate / 4) * i) / rate + Math.PI / 4);
	writeWav(f("isp.wav"), [x, x], { bits: 24 });
	const a = analyzeWav(f("isp.wav"));
	near(a.loudness.samplePeak, 20 * Math.log10(0.9 * Math.SQRT1_2), 0.2, "сэмпл-пик");
	near(a.loudness.truePeak, 20 * Math.log10(0.9), 0.5, "true peak");
	assert.ok(a.loudness.truePeak > a.loudness.samplePeak + 2);
});

test("громкость по 8-тактовым блокам: тихая и громкая половины видны", () => {
	const rate = 44100;
	// 120 BPM, 4/4: такт 2 с, блок из 8 тактов 16 с.
	const x = new Float32Array(rate * 64);
	x.set(sine(rate, 32, 1000, dbToAmp(-24)), 0);
	x.set(sine(rate, 32, 1000, dbToAmp(-12)), rate * 32);
	writeWav(f("blocks.wav"), [x, x], {});
	const a = analyzeWav(f("blocks.wav"), { tempo: 120 });
	assert.ok(a.blocks);
	assert.equal(a.blocks!.lufs.length, 4);
	near(a.blocks!.lufs[0], -24, 0.7);
	near(a.blocks!.lufs[3], -12, 0.7);
});

// --- полосы, стерео ----------------------------------------------------------------------

test("полосы: розовый шум — ровно по октавам", () => {
	const p = pinkNoise(44100, 30, 0.5, 11);
	writeWav(f("pink.wav"), [p, p], {});
	const a = analyzeWav(f("pink.wav"));
	// Розовый шум: энергия пропорциональна ширине полосы в октавах (от ~10 Гц до 22 кГц ≈ 11.1 октавы).
	const oct = [Math.log2(60 / 10), Math.log2(250 / 60), Math.log2(500 / 250), Math.log2(2000 / 500), Math.log2(8000 / 2000), Math.log2(22050 / 8000)];
	const total = oct.reduce((x, y) => x + y, 0);
	oct.forEach((o, i) => near(a.bands[i], 10 * Math.log10(o / total), 1.6, `полоса ${i}`));
});

test("полосы: синус 100 Гц — вся энергия в «низе»; синус 40 Гц — в сабе", () => {
	const lo = sine(44100, 6, 100, 0.5);
	writeWav(f("s100.wav"), [lo, lo], {});
	const a = analyzeWav(f("s100.wav"));
	assert.ok(a.bands[1] > -1, `низ ${a.bands[1]}`);
	assert.ok(a.bands[0] < -25);
	const sub = sine(44100, 6, 40, 0.5);
	writeWav(f("s40.wav"), [sub, sub], {});
	const b = analyzeWav(f("s40.wav"));
	assert.ok(b.bands[0] > -1);
	assert.ok(b.below50 > -1);
});

test("стерео: моно-в-стерео, широкий шум и противофаза низа", () => {
	const rate = 44100;
	const n1 = pinkNoise(rate, 10, 0.4, 1);
	const n2 = pinkNoise(rate, 10, 0.4, 2);
	writeWav(f("dual.wav"), [n1, n1], {});
	const d = analyzeWav(f("dual.wav"));
	near(d.stereo!.correlation, 1, 0.01);
	assert.equal(d.stereo!.widthTotal, 0);
	writeWav(f("wide.wav"), [n1, n2], {});
	const w = analyzeWav(f("wide.wav"));
	assert.ok(w.stereo!.correlation < 0.2, `корр. ${w.stereo!.correlation}`);
	assert.ok(w.stereo!.widthTotal > 40);
	// Бас 60 Гц в противофазе: корреляция низа -1, в моно низ пропадает.
	const b = sine(rate, 8, 60, 0.5);
	writeWav(f("phase.wav"), [b, b.map((v) => -v)], {});
	const p = analyzeWav(f("phase.wav"));
	near(p.stereo!.lowCorrelation, -1, 0.05);
	assert.ok(p.stereo!.lowMonoLoss < -20, `потеря в моно ${p.stereo!.lowMonoLoss}`);
	assert.match(summarizeAnalysis(p), /расходится по фазе/);
});

// --- бочка и бас -------------------------------------------------------------------------

function kickCase(name: string, spec: Parameters<typeof kickBassLoop>[0]) {
	const l = kickBassLoop(spec);
	writeWav(f(`${name}.wav`), [l, l], {});
	return analyzeWav(f(`${name}.wav`), { tempo: spec.bpm });
}

test("бочка и бас: бас тихий — бочка выступает, вердикт «читается»", () => {
	const a = kickCase("kick_clear", { seconds: 30, bpm: 120, kick: 0.8, bass: 0.15 });
	assert.ok(a.kick.count >= 55 && a.kick.count <= 65, `ударов ${a.kick.count}`);
	near(a.kick.intervalMs, 500, 20);
	assert.equal(a.kick.verdict, "clear");
	assert.ok(a.kick.stickOutDb! >= 9);
	assert.match(summarizeAnalysis(a), /бочка читается/);
	assert.doesNotMatch(summarizeAnalysis(a), /сайдчейн/);
});

test("бочка и бас: бас такой же громкий и непрерывный — «не уступает», сайдчейн", () => {
	const a = kickCase("kick_compete", { seconds: 30, bpm: 120, kick: 0.8, bass: 0.7 });
	assert.equal(a.kick.verdict, "compete");
	assert.ok(a.kick.stickOutDb! <= 4.5);
	assert.match(summarizeAnalysis(a), /бас по энергии не уступает бочке \(сайдчейн/);
});

test("бочка и бас: бас уже убирается на ударе — «дакинг», сайдчейн не советуем", () => {
	const a = kickCase("kick_duck", { seconds: 30, bpm: 120, kick: 0.8, bass: 0.7, duck: true });
	assert.equal(a.kick.verdict, "ducked");
	const t = summarizeAnalysis(a);
	assert.match(t, /уже уступает/);
	assert.doesNotMatch(t, /не уступает бочке/);
});

test("бочка и бас: без бочки и на шуме вердикта нет", () => {
	const p = pinkNoise(44100, 20, 0.5, 5);
	writeWav(f("noise_only.wav"), [p, p], {});
	const a = analyzeWav(f("noise_only.wav"));
	assert.equal(a.kick.verdict, "none");
	assert.match(summarizeAnalysis(a), /вердикта нет/);
	const b = sine(44100, 20, 55, 0.5);
	writeWav(f("bass_only.wav"), [b, b], {});
	assert.equal(analyzeWav(f("bass_only.wav")).kick.verdict, "none");
});

// --- сводка, сравнение -------------------------------------------------------------------

test("сводка: ≤ 1.5 КБ, цифры на месте, блоки по тактам", () => {
	const l = kickBassLoop({ seconds: 130, bpm: 128, kick: 0.7, bass: 0.3, hat: 0.05 });
	const n = pinkNoise(44100, 130, 0.2, 4);
	writeWav(f("full.wav"), [l.map((v, i) => v + n[i]), l.map((v, i) => v - n[i])], {});
	const a = analyzeWav(f("full.wav"), { tempo: 128 });
	const s = summarizeAnalysis(a);
	assert.ok(Buffer.byteLength(s, "utf8") <= SUMMARY_LIMIT, `байт: ${Buffer.byteLength(s, "utf8")}`);
	assert.match(s, /LUFS интегр\./);
	assert.match(s, /Полосы/);
	assert.match(s, /Стерео/);
	assert.match(s, /Бочка\/бас/);
	assert.match(s, /Громкость по 8 тактов/);
	assert.match(s, /2:10/);
});

test("сравнение: больше низкой середины и нет саба, тише референса — об этом и скажет", () => {
	const rate = 44100;
	// Референс: розовый шум + сильный саб 40 Гц; свой: тот же шум + «муть» 300 Гц, без саба, тише.
	const base = pinkNoise(rate, 15, 0.3, 3);
	const ref = base.map((v, i) => v + 0.25 * Math.sin((2 * Math.PI * 40 * i) / rate));
	const own = base.map((v, i) => 0.5 * (v + 0.2 * Math.sin((2 * Math.PI * 300 * i) / rate)));
	writeWav(f("ref.wav"), [ref, ref], {});
	writeWav(f("own.wav"), [own, own], {});
	const ra = analyzeWav(f("ref.wav"));
	const oa = analyzeWav(f("own.wav"));
	const c = compareAnalyses(oa, ra);
	assert.ok(c.lufsDiff < -3, `разница ${c.lufsDiff}`);
	near(c.matchGain, -c.lufsDiff, 1e-9);
	const lowmid = c.bands.find((b) => b.id === "lowmid")!;
	const sub = c.bands.find((b) => b.id === "sub")!;
	assert.ok(lowmid.diff > 2, `низкая середина ${lowmid.diff}`);
	assert.ok(sub.diff < -2, `саб ${sub.diff}`);
	assert.match(c.text, /тише на/);
	assert.match(c.text, /низкая середина 250–500 Гц \+/);
	assert.match(c.text, /почти нет|саба/);
	assert.ok(Buffer.byteLength(c.text, "utf8") <= SUMMARY_LIMIT);
});

test("сравнение: полосы не зависят от громкости — тот же трек, но на 6 дБ тише, даёт нулевую разницу полос", () => {
	const p = pinkNoise(44100, 12, 0.5, 9);
	const q = p.map((v) => v * 0.5);
	writeWav(f("loud.wav"), [p, p], {});
	writeWav(f("quiet.wav"), [q, q], {});
	const c = compareAnalyses(analyzeWav(f("quiet.wav")), analyzeWav(f("loud.wav")));
	near(c.lufsDiff, -6.02, 0.2);
	for (const b of c.bands) near(b.diff, 0, 0.3, b.id);
	assert.match(c.text, /Полосы близки/);
});

// --- длинный файл -------------------------------------------------------------------------

test("10 минут стерео 48 кГц: не дольше ~10 с и без разрастания памяти", () => {
	const rate = 48000;
	const loop = kickBassLoop({ rate, seconds: 10, bpm: 128, kick: 0.6, bass: 0.3, hat: 0.05 });
	const n = pinkNoise(rate, 10, 0.2, 3);
	const L = loop.map((v, i) => v + n[i]);
	const R = loop.map((v, i) => v - n[i]);
	writeWavRepeated(f("long.wav"), [L, R], 60, { rate, bits: 16 });
	const before = process.memoryUsage().rss;
	const t = Date.now();
	const a = analyzeWav(f("long.wav"), { tempo: 128 });
	const sec = (Date.now() - t) / 1000;
	const grown = (process.memoryUsage().rss - before) / 1048576;
	assert.equal(Math.round(a.info.duration), 600);
	assert.equal(a.blocks!.lufs.length, Math.ceil(600 / ((8 * 4 * 60) / 128)));
	assert.ok(sec < 10, `${sec} с — дольше 10`);
	assert.ok(grown < 150, `память выросла на ${grown.toFixed(0)} МБ`);
	console.log(`# 10 мин 48 кГц стерео: ${sec.toFixed(1)} с, +${grown.toFixed(0)} МБ`);
	rmSync(f("long.wav"));
});

// --- поиск wav ----------------------------------------------------------------------------

test("findWavs: свежие сверху, Samples и Backup пропускаются", () => {
	const root = path.join(dir, "docs");
	mkdirSync(path.join(root, "Проект", "Samples", "Recorded"), { recursive: true });
	mkdirSync(path.join(root, "Проект", "Backup"), { recursive: true });
	const old = path.join(root, "Проект", "старый.wav");
	const fresh = path.join(root, "Проект", "свежий.WAV");
	writeFileSync(old, "x");
	writeFileSync(fresh, "x");
	writeFileSync(path.join(root, "Проект", "Samples", "Recorded", "запись.wav"), "x");
	writeFileSync(path.join(root, "Проект", "Backup", "b.wav"), "x");
	writeFileSync(path.join(root, "трек.mp3"), "x");
	utimesSync(old, new Date("2026-11-01"), new Date("2026-11-01"));
	utimesSync(fresh, new Date("2026-11-25"), new Date("2026-11-25"));
	const found = findWavs([root]);
	assert.deepEqual(found.map((x) => path.basename(x.path)), ["свежий.WAV", "старый.wav"]);
});

// --- инструменты --------------------------------------------------------------------------

const audioExt = await import("../extensions/audio.ts");
function tools() {
	const map = new Map<string, any>();
	audioExt.default({ registerTool: (t: any) => map.set(t.name, t) } as any);
	return map;
}
const exec = (t: any, params: object, cwd: string) => t.execute("1", params, undefined, undefined, { cwd });

test("audio.ts: три инструмента; audio_analyze и audio_compare отдают сводку в модель", async () => {
	const t = tools();
	assert.deepEqual([...t.keys()], ["audio_list", "audio_analyze", "audio_compare"]);
	const s = sine(44100, 6, 1000, dbToAmp(-20));
	writeWav(f("tool_a.wav"), [s, s], {});
	writeWav(f("tool_b.wav"), [s.map((v) => v * 2), s.map((v) => v * 2)], {});
	const r = await exec(t.get("audio_analyze"), { path: "tool_a.wav" }, dir);
	assert.match(r.content[0].text, /LUFS интегр\./);
	assert.ok(Buffer.byteLength(r.content[0].text, "utf8") <= SUMMARY_LIMIT);
	const c = await exec(t.get("audio_compare"), { path: "tool_a.wav", reference: "tool_b.wav" }, dir);
	assert.match(c.content[0].text, /тише на 6\.0 LU/);
	near(c.details.lufsDiff, -6.02, 0.2);
});

test("audio.ts: mp3 и несуществующий файл — понятная ошибка, а не стек", async () => {
	const t = tools();
	await assert.rejects(() => exec(t.get("audio_analyze"), { path: "a.mp3" }, dir), /mp3, а не wav.*Export Audio\/Video/s);
	await assert.rejects(() => exec(t.get("audio_analyze"), { path: "нет_такого.wav" }, dir), /Нет файла/);
	await assert.rejects(() => exec(t.get("audio_compare"), { path: "tool_a.wav", reference: "a.mp3" }, dir), /mp3, а не wav/);
});

test("audio.ts: тихий вид — вызов и итог одной строкой", () => {
	const t = tools();
	const theme = { fg: (_c: string, s: string) => s };
	for (const name of ["audio_list", "audio_analyze", "audio_compare"]) {
		const tool = t.get(name);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(tool.renderCall({ path: "C:\\Музыка\\трек.wav" }, theme, {}).render(200).length, 1);
	}
});

