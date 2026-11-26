import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./stubs/packages.ts";
import { buildAls } from "./alsbuild.ts";

const play = await import("../extensions/play.ts");

const BASS = [
	{ pitch: 36, start: 0, duration: 3, velocity: 100 },
	{ pitch: 48, start: 3, duration: 1, velocity: 90 },
	{ pitch: 31, start: 4, duration: 3, velocity: 100 },
	{ pitch: 38, start: 7, duration: 1, velocity: 90 },
	{ pitch: 33, start: 8, duration: 3, velocity: 100 },
	{ pitch: 45, start: 11, duration: 1, velocity: 90 },
	{ pitch: 29, start: 12, duration: 3, velocity: 100 },
	{ pitch: 36, start: 15, duration: 1, velocity: 90 },
];

/** Проект с басом и (необязательно) сыгранным клипом. */
function project(dir: string, file: string, tracks: { name: string; clip: string; notes: typeof BASS }[]) {
	const p = path.join(dir, file);
	writeFileSync(
		p,
		buildAls({
			tempo: 100,
			tracks: tracks.map((t, i) => ({ type: "midi" as const, name: t.name, id: i + 1, clips: [{ name: t.clip, where: "session" as const, start: 0, length: 16, notes: t.notes }] })),
		}),
	);
	return p;
}

function fakeBridge(handler: (req: any) => any) {
	const seen: any[] = [];
	const server = net.createServer((sock) => {
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (d) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				seen.push(req);
				sock.write(JSON.stringify(handler(req)) + "\n");
			}
		});
	});
	return new Promise<{ port: number; seen: any[]; close: () => void }>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() })),
	);
}

function tools(env: Record<string, string>) {
	Object.assign(process.env, env);
	const map = new Map<string, any>();
	play.default({ registerTool: (t: any) => map.set(t.name, t) } as any);
	return map;
}

const run = (t: any, params: object, cwd: string) => t.execute("1", params, undefined, undefined, { cwd });

test("play.ts: инструмент один — play_check", () => {
	assert.deepEqual([...tools({}).keys()], ["play_check"]);
});

test("play_check: цель из .als, сыгранное — последний клип из Live", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-play-"));
	project(dir, "Ночь.als", [{ name: "Bass", clip: "Бас", notes: BASS }]);
	// Сыграно с ошибками: опоздал на 40 мс (0.0667 доли при 100 BPM), одну ноту взял на полутон выше, одну пропустил.
	const played = BASS.map((n) => ({ ...n, start: n.start + 0.0667 }));
	played[4] = { ...played[4], pitch: 34 }; // A1 -> Bb1
	played.splice(3, 1); // без D2
	const bridge = await fakeBridge((r) => {
		if (r.cmd === "song") return { ok: true, result: { tempo: 100 } };
		if (r.cmd === "last_clip") return { ok: true, result: { exists: true, is_midi_clip: true, track: 1, track_name: "Бас", slot: 0, name: "Моя запись", length: 16, how: "playing", notes: played } };
		return { ok: false, error: "?" };
	});
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port), MM_LIVE_HOST: "127.0.0.1" });
		const out = await run(t.get("play_check"), { path: "Ночь.als", track: "Bass", clip: "Бас", live_track: "Бас" }, dir);
		const body = out.content[0].text;
		assert.match(body, /цель «Бас» на «Bass» \(8 нот\)/);
		assert.match(body, /сыграно «Моя запись» на «Бас», слот 0 \(только что записан и играет\)/);
		assert.match(body, /6 из 8 нот верно/);
		assert.match(body, /1 не та высота/);
		assert.match(body, /1 пропущено/);
		assert.match(body, /опаздываешь в среднем на 40 мс/);
		assert.match(body, /полтона выше/);
		assert.equal(out.details.missing.length, 1);
		assert.match(out.details.verdict, /6 из 8 нот/);
		assert.equal(bridge.seen[0].cmd, "last_clip");
	} finally {
		bridge.close();
	}
});

test("play_check: сыгранное из другого .als (played_path)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-play-"));
	project(dir, "Ночь.als", [{ name: "Bass", clip: "Бас", notes: BASS }]);
	project(dir, "Ночь — запись.als", [{ name: "Бас — запись", clip: "Моя попытка", notes: BASS.slice(0, 6) }]);
	const t = tools({ MM_LIVE_PORT: "1" });
	const out = await run(
		t.get("play_check"),
		{ path: "Ночь.als", track: 1, clip: 1, played_path: "Ночь — запись.als", played_track: 1, played_clip: 1 },
		dir,
	);
	assert.match(out.content[0].text, /6 из 8 нот верно/);
	assert.match(out.content[0].text, /2 пропущено/);
	assert.match(out.content[0].text, /темп 100 BPM/);
});

test("play_check: цель и сыгранное списками нот, темп из Live", async () => {
	const bridge = await fakeBridge((r) => (r.cmd === "song" ? { ok: true, result: { tempo: 120 } } : { ok: false, error: "?" }));
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port), MM_LIVE_HOST: "127.0.0.1" });
		const goal = [{ pitch: 60, start: 0 }, { pitch: 64, start: 1 }];
		const played = [{ pitch: 60, start: 0 }, { pitch: 64, start: 1.2 }];
		const out = await run(t.get("play_check"), { goal_notes: goal, played_notes: played, tolerance: 0.25 }, tmpdir());
		assert.match(out.content[0].text, /2 из 2 нот верно/);
		assert.match(out.content[0].text, /темп 120 BPM/);
		assert.match(out.content[0].text, /опоздал/);
	} finally {
		bridge.close();
	}
});

test("play_check: старый мост без last_clip — запасной путь через tracks", async () => {
	const bridge = await fakeBridge((r) => {
		if (r.cmd === "last_clip") return { ok: false, error: "Неизвестная команда 'last_clip'. Есть: clip_notes, tracks." };
		if (r.cmd === "tracks") return { ok: true, result: { tracks: [{ index: 0, name: "Бас", clips: [{ slot: 0, name: "старый", is_midi_clip: true }, { slot: 2, name: "новая запись", is_midi_clip: true }] }] } };
		if (r.cmd === "clip_notes") return { ok: true, result: { exists: true, name: "новая запись", slot: 2, notes: BASS } };
		if (r.cmd === "song") return { ok: true, result: { tempo: 100 } };
		return { ok: false, error: "?" };
	});
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port), MM_LIVE_HOST: "127.0.0.1" });
		const out = await run(t.get("play_check"), { goal_notes: BASS, live_track: "Бас" }, tmpdir());
		assert.match(out.content[0].text, /8 из 8 нот верно/);
		assert.deepEqual(bridge.seen.map((r) => r.cmd).slice(0, 3), ["last_clip", "tracks", "clip_notes"]);
	} finally {
		bridge.close();
	}
});

test("play_check: понятные ошибки — нет цели, пустая запись, нет клипа", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-play-"));
	project(dir, "Ночь.als", [{ name: "Bass", clip: "Бас", notes: BASS }]);
	const bridge = await fakeBridge((r) => {
		if (r.cmd === "last_clip") return { ok: true, result: { exists: true, is_midi_clip: true, track: 0, track_name: "Бас", slot: 0, name: "пусто", how: "last", notes: [] } };
		return { ok: false, error: "?" };
	});
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port), MM_LIVE_HOST: "127.0.0.1" });
		await assert.rejects(run(t.get("play_check"), { path: "Ночь.als", track: 1, clip: 1 }, dir), /Не вижу, что ты сыграл/);
		await assert.rejects(run(t.get("play_check"), {}, dir), /Не понял цель/);
		await assert.rejects(run(t.get("play_check"), { goal_notes: BASS, live_track: "Бас" }, dir), /В клипе пусто/);
		await assert.rejects(run(t.get("play_check"), { path: "Ночь.als", track: 9, clip: 1, played_notes: BASS }, dir), /Нет трека «9»/);
		await assert.rejects(run(t.get("play_check"), { path: "Ночь.als", track: "Bass", clip: "нет такого", played_notes: BASS }, dir), /Нет клипа «нет такого»/);
	} finally {
		bridge.close();
	}
});
