#!/usr/bin/env node
/**
 * Ретранслятор сервера наставника (T1940): Win7 не выпустить TCP наружу, зато Live 10 умеет HTTPS.
 *
 * Для pi мост по-прежнему TCP `127.0.0.1:<порт ученика>`, одна JSON-строка туда, одна обратно. Здесь эта строка
 * кладётся в очередь ученика, а мост на его компьютере забирает её по HTTPS (long-poll) и отдаёт ответ:
 *
 *   GET  /mentor/b/<token>/next    -> 200 {id, line} | 204 (нет запросов ~25 с)
 *   POST /mentor/b/<token>/result  {id, line}
 *   *    /mentor/t/<token>/...     -> веб-терминал ttyd этого ученика (HTTP и WebSocket)
 *
 * Токен — ≥ 32 случайных байта; на диске только его sha256 (реестр `registryDir/<имя>.json`: {name, uid, port, sha256}).
 * Чужой или пустой токен — 403. Без зависимостей, только Node.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Ответ pi, когда Live не ответил (та же форма, что у моста). */
const TIMEOUT_REPLY = JSON.stringify({ ok: false, error: "timeout: Live не ответил" });

/**
 * @param {object} opts
 * @param {string} opts.registryDir
 * @param {number} [opts.httpPort] 0 — любой свободный
 * @param {boolean} [opts.bridgePorts] слушать TCP-порты учеников
 * @param {number} [opts.waitMs] длина long-poll
 * @param {number} [opts.offlineMs] мост «онлайн», если был next не раньше этого
 * @param {number} [opts.timeoutMs] ответ на запрос pi
 * @param {string} [opts.runDir] каталог unix-сокетов ttyd
 * @param {string} [opts.ttyd] путь к ttyd (null — веб-терминал выключен)
 * @param {(user: string) => string[]} [opts.webCommand] что ttyd запускает на каждую вкладку
 */
export function createRelay(opts) {
	const o = {
		host: "127.0.0.1",
		httpPort: 8794,
		bridgePorts: true,
		waitMs: 25_000,
		offlineMs: 40_000,
		timeoutMs: 35_000,
		maxBody: 2 << 20,
		maxLine: 1 << 20,
		runDir: "/run/mm",
		ttyd: "ttyd",
		webCommand: (user) => ["/usr/local/bin/mentor_web", user],
		log: (m) => console.log(new Date().toISOString() + " " + m),
		...opts,
	};
	/** @type {Map<string, any>} */
	const learners = new Map();
	/** @type {Map<string, any>} */
	const byHash = new Map();
	let lastReload = 0;
	let httpServer;
	let timer;

	const online = (L) => !!L.waiter || Date.now() - L.lastNext < o.offlineMs;

	// --- реестр -----------------------------------------------------------------------------------------------
	function reload() {
		lastReload = Date.now();
		let files = [];
		try {
			files = fs.readdirSync(o.registryDir).filter((f) => f.endsWith(".json"));
		} catch {
			/* каталога ещё нет */
		}
		const seen = new Set();
		for (const f of files) {
			let rec;
			try {
				rec = JSON.parse(fs.readFileSync(path.join(o.registryDir, f), "utf8"));
			} catch {
				continue;
			}
			if (!rec || typeof rec.name !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(rec.name) || !Number.isInteger(rec.port) || !/^[0-9a-f]{64}$/.test(rec.sha256 ?? "")) continue;
			seen.add(rec.name);
			let L = learners.get(rec.name);
			if (!L) {
				L = { name: rec.name, port: 0, hash: "", queue: [], inflight: new Map(), waiter: null, lastNext: 0, nextId: 1, server: null, ttyd: null };
				learners.set(rec.name, L);
			}
			if (L.hash !== rec.sha256) {
				byHash.delete(L.hash);
				L.hash = rec.sha256;
				byHash.set(L.hash, L);
				if (L.ttyd) stopTtyd(L); // токен сменился — старый адрес терминала не должен жить
			}
			if (L.port !== rec.port) {
				closePort(L);
				L.port = rec.port;
			}
			if (o.bridgePorts && !L.server) listenPort(L);
		}
		for (const [name, L] of [...learners]) {
			if (seen.has(name)) continue;
			closePort(L);
			stopTtyd(L);
			byHash.delete(L.hash);
			for (const p of [...L.inflight.values()]) finish(L, p, TIMEOUT_REPLY);
			learners.delete(name);
			o.log(`ученик ${name} удалён из реестра`);
		}
	}

	function lookup(token) {
		if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;
		const h = sha256(token); // поиск по хешу: сравнение токена не зависит от того, сколько символов совпало
		let L = byHash.get(h);
		if (!L && Date.now() - lastReload > 300) {
			reload();
			L = byHash.get(h);
		}
		return L;
	}

	// --- очередь запросов pi ----------------------------------------------------------------------------------
	function finish(L, p, resp) {
		if (p.done) return;
		p.done = true;
		clearTimeout(p.timer);
		L.inflight.delete(p.id);
		const i = L.queue.indexOf(p);
		if (i >= 0) L.queue.splice(i, 1);
		p.resolve(resp);
	}

	function submit(L, line) {
		const p = { id: String(L.nextId++), line, done: false, timer: null, resolve: null, promise: null };
		p.promise = new Promise((r) => (p.resolve = r));
		p.timer = setTimeout(() => finish(L, p, TIMEOUT_REPLY), o.timeoutMs);
		L.queue.push(p);
		L.inflight.set(p.id, p);
		flush(L);
		return p;
	}

	function flush(L) {
		if (!L.waiter || !L.queue.length) return;
		const w = L.waiter;
		L.waiter = null;
		clearTimeout(w.timer);
		const p = L.queue.shift();
		L.lastNext = Date.now();
		json(w.res, 200, { id: p.id, line: p.line });
	}

	function onNext(L, req, res) {
		L.lastNext = Date.now();
		if (L.waiter) {
			// прежний опрос — от перезапущенного моста: отпускаем
			clearTimeout(L.waiter.timer);
			L.waiter.res.writeHead(204).end();
			L.waiter = null;
		}
		const w = { res, timer: setTimeout(() => {
			if (L.waiter === w) L.waiter = null;
			L.lastNext = Date.now();
			res.writeHead(204, { "Cache-Control": "no-store" }).end();
		}, o.waitMs) };
		L.waiter = w;
		res.on("close", () => {
			if (L.waiter === w) {
				L.waiter = null;
				clearTimeout(w.timer);
			}
			L.lastNext = Date.now();
		});
		flush(L);
	}

	function readBody(req, res, cb) {
		const chunks = [];
		let n = 0;
		let dead = false;
		req.on("data", (c) => {
			if (dead) return;
			n += c.length;
			if (n > o.maxBody) {
				dead = true;
				json(res, 413, { ok: false, error: "too large" });
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => !dead && cb(Buffer.concat(chunks).toString("utf8")));
	}

	function onResult(L, req, res) {
		readBody(req, res, (text) => {
			let body;
			try {
				body = JSON.parse(text);
			} catch {
				return json(res, 400, { ok: false, error: "bad json" });
			}
			if (!body || typeof body.id !== "string" || typeof body.line !== "string" || body.line.length > o.maxLine) return json(res, 400, { ok: false, error: "bad body" });
			const p = L.inflight.get(body.id);
			if (!p) return json(res, 404, { ok: false, error: "unknown id" });
			finish(L, p, body.line);
			json(res, 200, { ok: true });
		});
	}

	// --- TCP-порт ученика (для pi) ----------------------------------------------------------------------------
	function listenPort(L) {
		const srv = net.createServer((sock) => onConn(L, sock));
		srv.on("error", (e) => {
			o.log(`порт ${L.port} (${L.name}): ${e.code ?? e.message}; повторю`);
			if (L.server === srv) L.server = null;
		});
		L.server = srv;
		srv.listen(L.port, "127.0.0.1", () => o.log(`${L.name}: слушаю 127.0.0.1:${L.port}`));
	}

	function closePort(L) {
		if (L.server) {
			try {
				L.server.close();
			} catch {
				/* уже закрыт */
			}
			L.server = null;
		}
	}

	function onConn(L, sock) {
		sock.setEncoding("utf8");
		let buf = "";
		let chain = Promise.resolve();
		const mine = new Set();
		let closed = false;
		const bye = () => {
			closed = true;
			for (const p of mine) finish(L, p, TIMEOUT_REPLY);
		};
		sock.on("close", bye);
		sock.on("error", () => sock.destroy());
		sock.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				if (!online(L)) {
					// Live закрыт или мост не включён: pi видит обрыв и говорит «открой Live»
					sock.destroy();
					return;
				}
				const p = submit(L, line);
				mine.add(p);
				chain = chain.then(() => p.promise).then((resp) => {
					mine.delete(p);
					if (!closed && !sock.destroyed) sock.write(resp + "\n");
				});
			}
			if (buf.length > o.maxLine) {
				sock.write('{"ok":false,"error":"request too long"}\n');
				sock.destroy();
			}
		});
	}

	// --- веб-терминал -----------------------------------------------------------------------------------------
	function stopTtyd(L) {
		if (L.ttyd) {
			try {
				L.ttyd.proc.kill("SIGTERM");
			} catch {
				/* уже умер */
			}
			L.ttyd = null;
		}
	}

	/** Адрес unix-сокета ttyd ученика; процесс стартует по первому обращению. */
	async function ensureTtyd(L) {
		if (L.ttyd?.ready) return L.ttyd.sock;
		if (!L.ttyd) {
			if (!o.ttyd) throw new Error("веб-терминал выключен");
			fs.mkdirSync(o.runDir, { recursive: true, mode: 0o700 });
			const sock = path.join(o.runDir, `t_${L.name}.sock`);
			try {
				fs.unlinkSync(sock);
			} catch {
				/* не было */
			}
			const args = [
				"-W", "-i", sock, "-b", `/mentor/t/${L.name}`, "-T", "xterm-256color", "-P", "5",
				"-t", "fontSize=16", "-t", "fontFamily=Consolas,'Courier New',monospace", "-t", "rendererType=canvas", "-t", "titleFixed=Музыкальный наставник", "-t", "disableLeaveAlert=true",
				...o.webCommand(L.name),
			];
			const proc = spawn(o.ttyd, args, { stdio: ["ignore", "ignore", "pipe"] });
			const rec = { proc, sock, ready: false, failed: false };
			L.ttyd = rec;
			proc.stderr.on("data", () => {});
			proc.on("exit", (code) => {
				if (L.ttyd === rec) L.ttyd = null;
				rec.failed = true;
				o.log(`ttyd ${L.name} вышел (${code})`);
			});
			proc.on("error", (e) => {
				rec.failed = true;
				o.log(`ttyd ${L.name}: ${e.message}`);
			});
		}
		const rec = L.ttyd;
		for (let i = 0; i < 100; i++) {
			if (rec.failed) throw new Error("ttyd не запустился");
			if (fs.existsSync(rec.sock)) {
				rec.ready = true;
				return rec.sock;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("ttyd не ответил");
	}

	/** Токен остаётся в URL браузера, а ttyd (его командную строку видят все в контейнере) знает только /mentor/t/<имя>. */
	function rewrite(req, L, r) {
		const q = req.url.indexOf("?");
		const url = `/mentor/t/${L.name}${r.rest}${q >= 0 ? req.url.slice(q) : ""}`;
		return { url, method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, pipe: (d) => req.pipe(d) };
	}

	function proxyHttp(sock, req, res) {
		const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, (ur) => {
			res.writeHead(ur.statusCode ?? 502, ur.headers);
			ur.pipe(res);
		});
		up.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(up);
	}

	function proxyUpgrade(sock, req, socket, head) {
		const up = net.connect(sock);
		up.on("connect", () => {
			let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
			for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
			up.write(raw + "\r\n");
			if (head?.length) up.write(head);
			socket.pipe(up);
			up.pipe(socket);
		});
		const kill = () => {
			up.destroy();
			socket.destroy();
		};
		up.on("error", kill);
		socket.on("error", kill);
		up.on("close", () => socket.destroy());
		socket.on("close", () => up.destroy());
	}

	// --- HTTP -------------------------------------------------------------------------------------------------
	function json(res, status, obj) {
		if (res.headersSent) return;
		const body = JSON.stringify(obj);
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
		res.end(body);
	}

	const deny = (res) => json(res, 403, { ok: false, error: "forbidden" });

	function route(req) {
		const m = /^\/mentor\/(b|t)\/([^/?]*)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? "");
		return m ? { kind: m[1], token: m[2], rest: m[3] ?? "" } : undefined;
	}

	async function onRequest(req, res) {
		const r = route(req);
		if (!r) return json(res, 404, { ok: false });
		const L = lookup(r.token);
		if (!L) return deny(res);
		if (r.kind === "b") {
			if (r.rest === "/next" && req.method === "GET") return onNext(L, req, res);
			if (r.rest === "/result" && req.method === "POST") return onResult(L, req, res);
			return json(res, 404, { ok: false });
		}
		if (r.rest === "") {
			res.writeHead(301, { Location: `/mentor/t/${r.token}/`, "Cache-Control": "no-store" }).end();
			return;
		}
		try {
			proxyHttp(await ensureTtyd(L), rewrite(req, L, r), res);
		} catch (e) {
			json(res, 502, { ok: false, error: String(e.message) });
		}
	}

	async function onUpgrade(req, socket, head) {
		const r = route(req);
		const L = r && r.kind === "t" ? lookup(r.token) : undefined;
		if (!L) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		try {
			proxyUpgrade(await ensureTtyd(L), rewrite(req, L, r), socket, head);
		} catch {
			socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
		}
	}

	return {
		learners,
		async start() {
			reload();
			httpServer = http.createServer((req, res) => {
				onRequest(req, res).catch((e) => {
					o.log("ошибка запроса: " + (e?.stack ?? e));
					json(res, 500, { ok: false });
				});
			});
			httpServer.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head));
			httpServer.keepAliveTimeout = 65_000;
			await new Promise((resolve, reject) => {
				httpServer.once("error", reject);
				httpServer.listen(o.httpPort, o.host, resolve);
			});
			timer = setInterval(reload, 1000);
			timer.unref();
			return httpServer.address().port;
		},
		async stop() {
			clearInterval(timer);
			for (const L of learners.values()) {
				closePort(L);
				stopTtyd(L);
				clearTimeout(L.waiter?.timer);
				for (const p of [...L.inflight.values()]) finish(L, p, TIMEOUT_REPLY);
			}
			httpServer?.closeAllConnections();
			await new Promise((r) => (httpServer ? httpServer.close(() => r()) : r()));
		},
		reload,
	};
}

/** Записать ученика в реестр (токен — со стандартного ввода, в аргументах его нет). */
export function registerLearner(dir, { name, uid, port, token }) {
	if (!TOKEN_RE.test(token) || token.length < 43) throw new Error("токен короче 32 байт");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${name}.json`);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ name, uid, port, sha256: sha256(token) }) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** После пересоздания контейнера /home жив (том), а /etc/passwd — нет: возвращаем учеников из реестра. */
function restoreUsers(dir, log) {
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return;
	}
	for (const f of files) {
		try {
			const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
			if (spawnSync("id", [r.name]).status === 0) continue;
			const u = spawnSync("useradd", ["-M", "-u", String(r.uid), "-d", `/home/${r.name}`, "-s", "/bin/bash", "-G", "mentors", r.name]);
			log(`ученик ${r.name} восстановлен (${u.status === 0 ? "ok" : String(u.stderr)})`);
		} catch {
			/* битая запись — пропускаем */
		}
	}
}

function arg(name, def) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const registryDir = arg("--registry", process.env.MM_REGISTRY_DIR || "/home/.mm/learners");
	if (process.argv.includes("--register")) {
		const token = fs.readFileSync(0, "utf8").trim();
		registerLearner(registryDir, { name: arg("--name"), uid: Number(arg("--uid")), port: Number(arg("--port")), token });
		process.exit(0);
	}
	restoreUsers(registryDir, (m) => console.log(m));
	const web = process.env.MM_RELAY_WEB_CMD ? JSON.parse(process.env.MM_RELAY_WEB_CMD) : undefined;
	const relay = createRelay({
		registryDir,
		httpPort: Number(process.env.MM_RELAY_PORT) || 8794,
		host: process.env.MM_RELAY_HOST || "0.0.0.0", // в контейнере; наружу порт публикуется только на 127.0.0.1 хоста
		bridgePorts: process.env.MM_RELAY_BRIDGE_PORTS !== "0",
		runDir: process.env.MM_RELAY_RUN_DIR || "/run/mm",
		...(web ? { webCommand: () => web } : {}),
	});
	const port = await relay.start();
	console.log(`ретранслятор: http ${port}`);
	for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => relay.stop().finally(() => process.exit(0)));
}
