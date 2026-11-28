import { test, after } from "node:test";
import assert from "node:assert/strict";
import "./stubs/packages.ts";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, readSync, openSync, closeSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbToAmp, sine, writeWavRepeated } from "./wavbuild.ts";
import { analyzeWav } from "../lib/audio/analyze.ts";
import { buildAls } from "./alsbuild.ts";
import { fetchRemote, forgetRemoteContext, pruneCache } from "../lib/remote/client.ts";
import { normalizeUserPath } from "../lib/als/files.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "als");
const work = mkdtempSync(path.join(tmpdir(), "mm_remote_"));
after(() => rmSync(work, { recursive: true, force: true }));

const HOME = "C:\\Users\\Max";
const DOCS = `${HOME}\\Documents`;

/** «Диск ученика»: виндовые пути → настоящие файлы в tmp. Мост отдаёт только .als/.wav внутри корней. */
function studentBridge(disk: Map<string, string>, roots = [DOCS]) {
	const seen: any[] = [];
	const inRoots = (p: string) => roots.some((r) => p.toLowerCase().startsWith(r.toLowerCase() + "\\"));
	const handle = (req: any) => {
		if (req.cmd === "ping") return { ok: true, result: { pong: true, bridge: "MentorBridge", version: 3, live: "10.1.43", python: "2.7.15" } };
		if (req.cmd === "files_list") {
			if (req.roots_only) return { ok: true, result: { files: [], roots, home: HOME, truncated: false } };
			const ext = req.kind === "wav" ? /\.wav$/i : /\.als$/i;
			const files = [...disk].filter(([p]) => ext.test(p) && inRoots(p)).map(([p, f]) => ({ path: p, size: statSync(f).size, mtime: Math.round(statSync(f).mtimeMs) }));
			return { ok: true, result: { files: files.sort((a, b) => b.mtime - a.mtime), roots, home: HOME, truncated: false } };
		}
		if (req.cmd === "file_read") {
			const p: string = req.path;
			if (!/\.(als|wav)$/i.test(p)) return { ok: false, error: `Мост отдаёт только .als и .wav; «${p}» - не они.` };
			const real = [...disk].find(([k]) => k.toLowerCase() === p.toLowerCase());
			if (!real || !inRoots(real[0])) return { ok: false, error: `Файл «${p}» вне папок, которые мост отдаёт` };
			const st = statSync(real[1]);
			const len = Math.min(req.length, 512 * 1024);
			const buf = Buffer.alloc(len);
			const fd = openSync(real[1], "r");
			const n = readSync(fd, buf, 0, len, req.offset);
			closeSync(fd);
			return { ok: true, result: { data: buf.subarray(0, n).toString("base64"), eof: req.offset + n >= st.size, size: st.size, mtime: Math.round(st.mtimeMs) } };
		}
		return { ok: false, error: "неизвестная команда" };
	};
	const socks = new Set<net.Socket>();
	const server = net.createServer((sock) => {
		socks.add(sock);
		sock.on("close", () => socks.delete(sock));
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("error", () => {});
		sock.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				seen.push(req);
				sock.write(JSON.stringify(handle(req)) + "\n");
			}
		});
	});
	return new Promise<{ port: number; seen: any[]; reads: () => number; close: () => Promise<void> }>((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				port: (server.address() as net.AddressInfo).port,
				seen,
				reads: () => seen.filter((r) => r.cmd === "file_read" && r.length > 1).length,
				close: () => new Promise<void>((r) => (socks.forEach((x) => x.destroy()), server.close(() => r()))),
			}),
		),
	);
}

function tools(...mods: any[]) {
	const map = new Map<string, any>();
	for (const m of mods) m.default({ registerTool: (t: any) => map.set(t.name, t) } as any);
	return map;
}
const run = (t: any, params: object, cwd: string) => t.execute("1", params, undefined, undefined, { cwd });

const als = await import("../extensions/als.ts");
const audio = await import("../extensions/audio.ts");
const live = await import("../extensions/live.ts");

const SONG = `${DOCS}\\Ночь\\Ночь.als`;
const disk = new Map<string, string>();
const mk = (name: string) => path.join(work, name);
copyFileSync(path.join(FIX, "12", "vm_session_chords.als"), mk("night.als"));
disk.set(SONG, mk("night.als"));
const outside = mk("secret.als");
copyFileSync(path.join(FIX, "12", "vm_session_chords.als"), outside);
disk.set("C:\\Windows\\secret.als", outside);

// WAV ≥ 20 МБ: стерео 44.1 кГц 16 бит ≈ 176 КБ/с, 130 с ≈ 23 МБ
const BIG = `${DOCS}\\Ночь\\mix.wav`;
{
	const s = sine(44100, 10, 220, dbToAmp(-18));
	writeWavRepeated(mk("mix.wav"), [s, s], 13, { bits: 16 });
	disk.set(BIG, mk("mix.wav"));
}

const cacheDir = path.join(work, "cache");
function env(port: number) {
	Object.assign(process.env, { MM_REMOTE_FILES: "1", MM_LIVE_PORT: String(port), MM_CACHE_DIR: cacheDir });
	forgetRemoteContext();
}
after(() => {
	delete process.env.MM_REMOTE_FILES;
	delete process.env.MM_CACHE_DIR;
});

test("удалённый режим: project_list и project_summary по .als на диске ученика; пути остаются виндовыми", async () => {
	const bridge = await studentBridge(disk);
	env(bridge.port);
	try {
		const t = tools(als);
		const list = await run(t.get("project_list"), {}, work);
		assert.match(list.content[0].text, /Найдено 1/);
		assert.ok(list.content[0].text.includes(SONG), list.content[0].text);
		assert.ok(!list.content[0].text.includes("secret"), "корни: чужое не видно");
		const sum = await run(t.get("project_summary"), { path: SONG }, work);
		assert.match(sum.content[0].text, /Проект «Ночь»/);
		assert.ok(sum.details.tracks > 0);
		// ученик называет путь коротко
		const short = await run(t.get("project_summary"), { path: "Документы\\Ночь\\Ночь.als" }, work);
		assert.match(short.content[0].text, /Проект «Ночь»/);
		const quoted = await run(t.get("project_analysis"), { path: `"${SONG}"` }, work);
		assert.match(quoted.content[0].text, /Анализ «Ночь\.als»/);
	} finally {
		await bridge.close();
	}
});

test("удалённый режим: project_diff пишет снимок по имени из виндового пути", async () => {
	const bridge = await studentBridge(disk);
	env(bridge.port);
	const cwd = mkdtempSync(path.join(work, "cwd_"));
	try {
		const t = tools(als);
		const first = await run(t.get("project_diff"), { path: SONG }, cwd);
		assert.equal(first.details.first, true);
		assert.ok(readdirSync(path.join(cwd, "learner", "snapshots")).includes("Ночь.json"));
		const second = await run(t.get("project_diff"), { path: SONG }, cwd);
		assert.equal(second.details.first, false);
	} finally {
		await bridge.close();
	}
});

test("удалённый режим: audio_list и audio_analyze по WAV ≥ 20 МБ, время передачи; кэш срабатывает на повторе", async () => {
	const size = statSync(mk("mix.wav")).size;
	assert.ok(size >= 20 * 1024 * 1024, `WAV ${size}`);
	const bridge = await studentBridge(disk);
	env(bridge.port);
	try {
		const t = tools(audio);
		const list = await run(t.get("audio_list"), {}, work);
		assert.ok(list.content[0].text.includes(BIG));
		const t0 = Date.now();
		const a = await run(t.get("audio_analyze"), { path: BIG }, work);
		const total = Date.now() - t0;
		assert.match(a.content[0].text, /mix\.wav/);
		const direct = analyzeWav(mk("mix.wav"));
		assert.equal(a.details.loudness.integrated, direct.loudness.integrated, "через мост — те же цифры, что по локальному файлу");
		assert.ok(Math.abs(a.details.loudness.integrated - -18.9) < 0.5, String(a.details.loudness.integrated));
		const chunks = Math.ceil(size / (512 * 1024));
		assert.equal(bridge.reads(), chunks, "каждый кусок скачан один раз");
		const f = await fetchRemote(BIG, { addr: { host: "127.0.0.1", port: bridge.port }, cacheDir });
		assert.equal(f.cached, true);
		assert.equal(bridge.reads(), chunks, "повтор — из кэша, данных не качали");
		// чистая скорость передачи без анализа
		const cold = path.join(work, "cold_cache");
		const t1 = Date.now();
		const g = await fetchRemote(BIG, { addr: { host: "127.0.0.1", port: bridge.port }, cacheDir: cold });
		const ms = Date.now() - t1;
		assert.equal(g.cached, false);
		assert.equal(statSync(g.local).size, size);
		console.log(`# передача ${(size / 1048576).toFixed(1)} МБ: ${ms} мс (${((size / 1048576) / (ms / 1000)).toFixed(0)} МБ/с, ${chunks} кусков по 512 КБ, loopback); audio_analyze целиком: ${total} мс`);
		// файл изменился (mtime/size) — качаем заново
		const before = bridge.reads();
		const s = sine(44100, 10, 330, dbToAmp(-18));
		writeWavRepeated(mk("mix.wav"), [s, s], 13, { bits: 16 });
		utimesSync(mk("mix.wav"), new Date(), new Date(Date.now() + 5000));
		const h = await fetchRemote(BIG, { addr: { host: "127.0.0.1", port: bridge.port }, cacheDir });
		assert.equal(h.cached, false);
		assert.ok(bridge.reads() > before);
	} finally {
		await bridge.close();
	}
});

test("удалённый режим: путь вне корней и чужое расширение отвергаются мостом, дошло до ученика текстом моста", async () => {
	const bridge = await studentBridge(disk);
	env(bridge.port);
	try {
		const t = tools(als);
		await assert.rejects(run(t.get("project_summary"), { path: "C:\\Windows\\secret.als" }, work), /вне папок/);
		await assert.rejects(fetchRemote("C:\\Users\\Max\\Documents\\passwords.txt", { addr: { host: "127.0.0.1", port: bridge.port }, cacheDir }), /только \.als и \.wav/);
	} finally {
		await bridge.close();
	}
});

test("удалённый режим: мост закрыт — «открой Live», и список, и чтение", async () => {
	const probe = await studentBridge(disk);
	const port = probe.port;
	await probe.close();
	env(port);
	const t = tools(als, audio);
	for (const [tool, params] of [["project_list", {}], ["project_summary", { path: SONG }], ["audio_list", {}], ["audio_analyze", { path: BIG }]] as const) {
		await assert.rejects(run(t.get(tool), params, work), /открой Live — без него я не вижу твоих файлов/, tool);
	}
});

test("удалённый режим: туннель открыт, а Live закрыт (соединение рвётся без ответа) — то же сообщение", async () => {
	const dead = net.createServer((s) => s.destroy());
	await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
	env((dead.address() as net.AddressInfo).port);
	try {
		await assert.rejects(run(tools(als).get("project_list"), {}, work), /открой Live/);
		assert.equal(await live.liveRunning({ host: "127.0.0.1", port: (dead.address() as net.AddressInfo).port }), process.platform === "win32" ? await live.liveRunning() : false);
	} finally {
		dead.close();
	}
});

test("liveRunning вне Windows: ответ моста — запущен, закрытый порт — нет", async () => {
	if (process.platform === "win32") return;
	const bridge = await studentBridge(disk);
	assert.equal(await live.liveRunning({ host: "127.0.0.1", port: bridge.port }), true);
	const port = bridge.port;
	await bridge.close();
	assert.equal(await live.liveRunning({ host: "127.0.0.1", port }), false);
});

test("normalizeUserPath в удалённом режиме не трогает виндовые пути ученика", () => {
	const e = { MM_REMOTE_FILES: "1" } as NodeJS.ProcessEnv;
	assert.equal(normalizeUserPath(`"C:\\Users\\Max\\Documents\\Ночь.als"`, "/srv", e), "C:\\Users\\Max\\Documents\\Ночь.als");
	assert.equal(normalizeUserPath("C:/Users/Max/Ночь.als", "/srv", e), "C:\\Users\\Max\\Ночь.als");
	assert.equal(normalizeUserPath("Документы\\Ночь.als", "/srv", e), "Документы\\Ночь.als");
	assert.notEqual(normalizeUserPath("Документы/Ночь.als", "/srv", {} as NodeJS.ProcessEnv), "Документы/Ночь.als"); // локально — прежнее поведение
});

test("кэш: старше 7 дней и сверх 2 ГБ чистится, свежее остаётся", () => {
	const dir = mkdtempSync(path.join(work, "prune_"));
	const now = Date.now();
	const put = (name: string, bytes: number, ageDays: number) => {
		writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
		const t = new Date(now - ageDays * 86_400_000);
		utimesSync(path.join(dir, name), t, t);
	};
	put("old.als", 10, 8);
	put("fresh.als", 10, 1);
	put("a.wav", 600, 3);
	put("b.wav", 600, 2);
	put("c.wav", 600, 1);
	const removed = pruneCache(dir, { maxBytes: 1500, now });
	assert.deepEqual(removed.sort(), ["a.wav", "old.als"]);
	assert.deepEqual(readdirSync(dir).sort(), ["b.wav", "c.wav", "fresh.als"]);
	mkdirSync(path.join(dir, "sub"));
});
