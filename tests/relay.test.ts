/** T1940: ретранслятор HTTPS-моста (tools/vps/relay/mm_relay.mjs): pi ↔ TCP-порт ученика ↔ HTTP long-poll моста. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BridgeClosed, sendLine } from "../lib/mm/bridge.ts";
import { openSession } from "../lib/mm/bridge.ts";

const relayMod = await import(path.join(import.meta.dirname, "..", "tools", "vps", "relay", "mm_relay.mjs"));

const token = () => crypto.randomBytes(32).toString("base64url");

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

async function setup(extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(path.join(tmpdir(), "mm_relay_"));
	const tok = token();
	const other = token();
	const port = await freePort();
	const port2 = await freePort();
	relayMod.registerLearner(dir, { name: "t1", uid: 1001, port, token: tok });
	relayMod.registerLearner(dir, { name: "t2", uid: 1002, port: port2, token: other });
	const relay = relayMod.createRelay({ registryDir: dir, httpPort: 0, log: () => {}, ...extra });
	const http = await relay.start();
	const base = `http://127.0.0.1:${http}/mentor/b`;
	return {
		tok, other, port, port2, base,
		next: (t = tok, signal?: AbortSignal) => fetch(`${base}/${t}/next`, { signal }),
		result: (id: string, line: string, t = tok) => fetch(`${base}/${t}/result`, { method: "POST", body: JSON.stringify({ id, line }) }),
		async stop() {
			await relay.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Фейковый мост: опрашивает next и отвечает на ping/file_read. */
function fakeBridge(s: Awaited<ReturnType<typeof setup>>, handler: (req: any) => Promise<string> | string) {
	let stop = false;
	const seen: any[] = [];
	const loop = async () => {
		while (!stop) {
			let r: Response;
			try {
				r = await s.next();
			} catch {
				return;
			}
			if (r.status !== 200) continue;
			const { id, line } = (await r.json()) as { id: string; line: string };
			const req = JSON.parse(line);
			seen.push(req);
			void (async () => s.result(id, await handler(req)))();
		}
	};
	const done = loop();
	return { seen, async stop() { stop = true; await Promise.race([done, new Promise((r) => setTimeout(r, 300))]); } };
}

test("relay: ping от pi по TCP доходит до моста по HTTP и ответ возвращается", async () => {
	const s = await setup({ waitMs: 300 });
	const b = fakeBridge(s, (req) => JSON.stringify({ ok: true, result: { pong: true, id: req.id } }));
	try {
		await new Promise((r) => setTimeout(r, 100));
		const resp = await sendLine({ cmd: "ping", id: 7 }, { host: "127.0.0.1", port: s.port }, 5000);
		assert.deepEqual(resp, { ok: true, result: { pong: true, id: 7 } });
		assert.equal(b.seen[0].cmd, "ping");
	} finally {
		await b.stop();
		await s.stop();
	}
});

test("relay: 4 параллельных file_read (по 512 КБ base64) на разных соединениях и порядок ответов в одном", async () => {
	const s = await setup({ waitMs: 300 });
	const chunk = Buffer.alloc(512 * 1024, 7).toString("base64");
	const b = fakeBridge(s, async (req) => {
		if (req.cmd === "file_read") {
			await new Promise((r) => setTimeout(r, 50 + (4 - req.offset) * 20)); // ответы моста приходят не по порядку
			return JSON.stringify({ ok: true, result: { offset: req.offset, data: chunk, eof: false } });
		}
		return '{"ok":true}';
	});
	try {
		await new Promise((r) => setTimeout(r, 100));
		const addr = { host: "127.0.0.1", port: s.port };
		const all = await Promise.all([0, 1, 2, 3].map((offset) => sendLine({ cmd: "file_read", path: "a.wav", offset }, addr, 10_000)));
		assert.deepEqual(all.map((r) => r.result.offset), [0, 1, 2, 3]);
		for (const r of all) assert.equal(r.result.data.length, chunk.length);
		// одно соединение, два запроса подряд — ответы в порядке запросов, даже если мост ответил наоборот
		const sess = openSession(addr, 10_000);
		const [x, y] = await Promise.all([sess.request({ cmd: "file_read", offset: 0 }), sess.request({ cmd: "file_read", offset: 3 })]);
		sess.close();
		assert.equal(x.result.offset, 0);
		assert.equal(y.result.offset, 3);
	} finally {
		await b.stop();
		await s.stop();
	}
});

test("relay: моста нет — соединение pi сразу закрывается (BridgeClosed), быстро", async () => {
	const s = await setup({ waitMs: 300 });
	try {
		const t0 = Date.now();
		await assert.rejects(sendLine({ cmd: "ping" }, { host: "127.0.0.1", port: s.port }, 5000), BridgeClosed);
		assert.ok(Date.now() - t0 < 1000, `отказ занял ${Date.now() - t0} мс`);
	} finally {
		await s.stop();
	}
});

test("relay: мост был, но замолчал дольше offlineMs — снова отказ", async () => {
	const s = await setup({ waitMs: 100, offlineMs: 400 });
	try {
		const r = await s.next();
		assert.equal(r.status, 204);
		await new Promise((r) => setTimeout(r, 600));
		await assert.rejects(sendLine({ cmd: "ping" }, { host: "127.0.0.1", port: s.port }, 5000), BridgeClosed);
	} finally {
		await s.stop();
	}
});

test("relay: мост принял запрос и не ответил — pi получает timeout-ответ", async () => {
	const s = await setup({ waitMs: 300, timeoutMs: 400 });
	const b = fakeBridge(s, () => new Promise<string>(() => {}));
	try {
		await new Promise((r) => setTimeout(r, 100));
		const resp = await sendLine({ cmd: "ping" }, { host: "127.0.0.1", port: s.port }, 5000);
		assert.equal(resp.ok, false);
		assert.match(resp.error, /timeout/);
	} finally {
		await b.stop();
		await s.stop();
	}
});

test("relay: чужой, пустой и короткий токен — 403; токен одного ученика не открывает другого", async () => {
	const s = await setup({ waitMs: 100 });
	try {
		for (const t of ["", "x", "a".repeat(43), s.tok + "x", s.tok.slice(0, -1)]) {
			const r = await fetch(`${s.base}/${t}/next`);
			assert.equal(r.status, 403, `токен «${t}»`);
		}
		const r = await fetch(`${s.base}/${s.tok}/result`, { method: "POST", body: JSON.stringify({ id: "1", line: "x" }) });
		assert.equal(r.status, 404, "свой токен, но такого запроса нет");
		const r2 = await fetch(`${s.base}/${"b".repeat(43)}/result`, { method: "POST", body: "{}" });
		assert.equal(r2.status, 403);
		// терминал: тот же отказ
		const t = await fetch(`${s.base.replace("/b", "/t")}/${"c".repeat(43)}/`);
		assert.equal(t.status, 403);
		// мост ученика 2 опрашивает очередь: запрос на порт ученика 1 до него не доходит
		const b2 = fakeBridge({ ...s, next: (t = s.other) => s.next(t), result: (id: string, l: string) => s.result(id, l, s.other) }, () => '{"ok":true,"result":"t2"}');
		await new Promise((r) => setTimeout(r, 50));
		await assert.rejects(sendLine({ cmd: "ping" }, { host: "127.0.0.1", port: s.port }, 3000), BridgeClosed);
		assert.equal((await sendLine({ cmd: "ping" }, { host: "127.0.0.1", port: s.port2 }, 3000)).result, "t2");
		await b2.stop();
	} finally {
		await s.stop();
	}
});

test("relay: токен хранится только хешем", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm_relay_"));
	try {
		const tok = token();
		relayMod.registerLearner(dir, { name: "t9", uid: 1, port: 9999, token: tok });
		const raw = (await import("node:fs")).readFileSync(path.join(dir, "t9.json"), "utf8");
		assert.ok(!raw.includes(tok));
		assert.match(raw, /"sha256":"[0-9a-f]{64}"/);
		assert.throws(() => relayMod.registerLearner(dir, { name: "t9", uid: 1, port: 9999, token: "short" }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("relay: тело result больше лимита — 413", async () => {
	const s = await setup({ waitMs: 100 });
	try {
		const r = await fetch(`${s.base}/${s.tok}/result`, { method: "POST", body: "x".repeat(3 << 20) }).catch(() => undefined);
		assert.ok(!r || r.status === 413);
	} finally {
		await s.stop();
	}
});
