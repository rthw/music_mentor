import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

try {
	await import("typebox");
} catch {
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "typebox") return { url: new URL("./stubs/typebox.ts", import.meta.url).href, shortCircuit: true };
			return next(specifier, context);
		},
	});
}
const live = await import("../extensions/live.ts");

/** Фейковый мост: отвечает по таблице, запоминает запросы. */
function fakeBridge(handler: (req: any) => any) {
	const seen: any[] = [];
	const server = net.createServer((sock) => {
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const req = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				seen.push(req);
				sock.write(JSON.stringify(handler(req)) + "\n");
			}
		});
	});
	return new Promise<{ port: number; seen: any[]; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() })));
}

function tools(env: Record<string, string>) {
	Object.assign(process.env, env);
	const map = new Map<string, any>();
	live.default({ registerTool: (t: any) => map.set(t.name, t) } as any);
	return map;
}

const run = (t: any, params: object, cwd: string) => t.execute("1", params, undefined, undefined, { cwd });

test("live.ts: набор тулов", async () => {
	const t = tools({});
	assert.deepEqual([...t.keys()].sort(), ["live_add_clip", "live_add_track", "live_browser", "live_clip_notes", "live_load_device", "live_ping", "live_play", "live_remove", "live_set_param", "live_state", "live_stop"]);
});

test("live.ts: ping, state, ошибка моста доходит как есть", async () => {
	const bridge = await fakeBridge((r) => {
		if (r.cmd === "ping") return { ok: true, result: { pong: true, bridge: "MentorBridge", version: 1, live: "12.1.5", python: "3.11.0" } };
		if (r.cmd === "song") return { ok: true, result: { tempo: 128, signature: [4, 4], is_playing: false, track_count: 1, scene_count: 4 } };
		if (r.cmd === "tracks") return { ok: true, result: { tracks: [{ index: 0, name: "Бас", type: "midi", hint: false, devices: [{ name: "Wavetable" }], clips: [{ slot: 0, name: "Мой бас", length: 4, is_midi_clip: true, note_count: 8 }] }] } };
		if (r.cmd === "set_param") return { ok: false, error: "Это трек ученика «Бас»: менять параметры его устройств нельзя." };
		return { ok: false, error: "?" };
	});
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port), MM_LIVE_HOST: "127.0.0.1" });
		const dir = mkdtempSync(path.join(tmpdir(), "mm-live-"));
		assert.match((await run(t.get("live_ping"), {}, dir)).content[0].text, /Live 12\.1\.5, мост MentorBridge v1/);
		const st = (await run(t.get("live_state"), {}, dir)).content[0].text;
		assert.match(st, /Темп 128/);
		assert.match(st, /«Мой бас» 4 долей, 8 нот/);
		await assert.rejects(run(t.get("live_set_param"), { track: "Бас", device: 0, param: "Volume", value: 1 }, dir), /Это трек ученика/);
	} finally {
		bridge.close();
	}
});

test("live.ts: копия .als до первой записи, одна на сессию", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm-live-"));
	const als = path.join(dir, "Мой трек.als");
	writeFileSync(als, "fake-als");
	const bridge = await fakeBridge((r) => {
		if (r.cmd === "song") return { ok: true, result: { file_path: als } };
		if (r.cmd === "add_midi_track") return { ok: true, result: { index: 1, name: "Подсказка: " + r.name } };
		if (r.cmd === "add_clip") return { ok: true, result: { track: r.track, slot: r.slot, name: "Подсказка: " + r.name, length: r.length_beats, note_count: r.notes.length } };
		return { ok: false, error: "?" };
	});
	try {
		const t = tools({ MM_LIVE_PORT: String(bridge.port) });
		const r1 = await run(t.get("live_add_track"), { name: "идея" }, dir);
		assert.match(r1.content[0].text, /Копия проекта до правок: .*learner.backups.\d{4}-\d\d-\d\d_Мой трек\.als/);
		assert.match(r1.content[0].text, /Ctrl\+Z/);
		const backups = readdirSync(path.join(dir, "learner", "backups"));
		assert.equal(backups.length, 1);
		const r2 = await run(t.get("live_add_clip"), { track: 1, slot: 0, length_beats: 4, notes: [{ pitch: 60, start: 0, duration: 1 }], name: "аккорд" }, dir);
		assert.doesNotMatch(r2.content[0].text, /Копия/);
		assert.equal(bridge.seen.filter((q) => q.cmd === "song").length, 1);
		// чтение копию не делает
		const dir2 = mkdtempSync(path.join(tmpdir(), "mm-live-"));
		await run(t.get("live_stop"), {}, dir2).catch(() => {});
		assert.equal(existsSync(path.join(dir2, "learner")), false);
	} finally {
		bridge.close();
	}
});

test("live.ts: порт закрыт — шаги включения Control Surface", async () => {
	const probe = await fakeBridge(() => ({ ok: true, result: {} }));
	const port = probe.port;
	probe.close();
	await new Promise((r) => setTimeout(r, 50));
	const t = tools({ MM_LIVE_PORT: String(port) });
	const dir = mkdtempSync(path.join(tmpdir(), "mm-live-"));
	await assert.rejects(run(t.get("live_ping"), {}, dir), (e: Error) => /Control Surface/.test(e.message) && /Link, Tempo & MIDI/.test(e.message) && /Link MIDI/.test(e.message) && /MentorBridge/.test(e.message));
});
