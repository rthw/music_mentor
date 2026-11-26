#!/usr/bin/env node
/**
 * Приёмник заявок music_mentor: POST /api/wish на 127.0.0.1:8793.
 *
 * Caddy сайта present (tools/present/Caddyfile) проксирует /api/* сюда, cloudflared ведёт домен на Caddy.
 * Приёмник открыт в интернет, поэтому: токен, размер тела ≤ 4 КБ, лимит частоты (5 в сутки на IP, 60 в сутки на всех),
 * проверка содержимого (не JSON, короткое, не текст — отброшено). Принятое — в журнал (JSONL) и автору в Telegram
 * существующим каналом `tg-send` (одностороннее сообщение; токен бота этот процесс не видит).
 *
 *   node tools/wish/wish_receiver.mjs                # слушает 127.0.0.1:8793
 * Окружение: WISH_PORT, WISH_JOURNAL (по умолчанию ~/.local/share/music_mentor_wishes/wishes.jsonl),
 * WISH_NOTIFY (команда уведомления, по умолчанию ~/.local/bin/tg-send; читает текст со stdin).
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { proto } from "../../lib/mm/wish_proto.ts";

const DAY = 24 * 60 * 60 * 1000;

/** Текст заявки пригоден: строка, длина в пределах, в основном буквы, не один повторяющийся знак. */
export function cleanText(raw) {
	if (typeof raw !== "string") return null;
	// управляющие знаки (кроме перевода строки и табуляции) выбрасываем
	const t = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
	if (t.length < proto.minTextChars || t.length > proto.maxTextChars) return null;
	const letters = (t.match(/\p{L}/gu) ?? []).length;
	if (letters < 6 || letters / t.length < 0.4) return null;
	const counts = new Map();
	for (const ch of t) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	if (Math.max(...counts.values()) / [...t].length > 0.5) return null;
	return t;
}

/** Лимит «не более n за сутки» по ключу; ключи старше суток забываются. */
export class Limiter {
	constructor(perKey, total) {
		this.perKey = perKey;
		this.total = total;
		this.byKey = new Map();
		this.all = [];
	}
	/** true — пропустить и записать; false — лимит. */
	take(key, now) {
		this.all = this.all.filter((t) => now - t < DAY);
		const mine = (this.byKey.get(key) ?? []).filter((t) => now - t < DAY);
		if (mine.length >= this.perKey || this.all.length >= this.total) {
			this.byKey.set(key, mine);
			return false;
		}
		mine.push(now);
		this.all.push(now);
		this.byKey.set(key, mine);
		return true;
	}
}

function clientIp(req) {
	const cf = req.headers["cf-connecting-ip"];
	if (typeof cf === "string" && cf.trim()) return cf.trim();
	const xff = req.headers["x-forwarded-for"];
	if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
	return req.socket.remoteAddress ?? "?";
}

/** Отправить текст автору командой уведомления (stdin → Telegram). */
export function notifyViaCommand(command) {
	return (text) =>
		new Promise((resolve) => {
			let done = false;
			const finish = (ok) => {
				if (!done) {
					done = true;
					resolve(ok);
				}
			};
			try {
				const child = spawn(command, ["--plain"], { stdio: ["pipe", "ignore", "ignore"] });
				const timer = setTimeout(() => {
					try {
						child.kill();
					} catch {}
					finish(false);
				}, 30_000);
				child.on("error", () => finish(false));
				child.on("close", (code) => {
					clearTimeout(timer);
					finish(code === 0);
				});
				child.stdin.on("error", () => {});
				child.stdin.end(text);
			} catch {
				finish(false);
			}
		});
}

export function createReceiver(opts = {}) {
	const journal = opts.journal ?? path.join(os.homedir(), ".local", "share", "music_mentor_wishes", "wishes.jsonl");
	const notify = opts.notify ?? notifyViaCommand(path.join(os.homedir(), ".local", "bin", "tg-send"));
	const now = opts.now ?? (() => Date.now());
	const limiter = new Limiter(opts.perIpPerDay ?? proto.perIpPerDay, opts.globalPerDay ?? proto.globalPerDay);
	// id -> принято ли автором в Telegram: повтор того же id не плодит дубли.
	const seen = new Map();
	try {
		for (const line of readFileSync(journal, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const e = JSON.parse(line);
			if (e.id) seen.set(e.id, !!e.forwarded);
		}
	} catch {}

	const write = (entry) => {
		try {
			mkdirSync(path.dirname(journal), { recursive: true });
			appendFileSync(journal, JSON.stringify(entry) + "\n", "utf8");
		} catch (err) {
			console.error("журнал не пишется:", err.message);
		}
	};
	const reply = (res, status, body) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};

	return http.createServer((req, res) => {
		const url = (req.url ?? "").split("?")[0];
		if (url !== "/api/wish") return reply(res, 404, { ok: false });
		if (req.method !== "POST") return reply(res, 405, { ok: false });
		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > proto.maxBodyBytes) {
			req.resume();
			return reply(res, 413, { ok: false, error: "слишком большая заявка" });
		}
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (c) => {
			size += c.length;
			if (size > proto.maxBodyBytes) {
				aborted = true;
				reply(res, 413, { ok: false, error: "слишком большая заявка" });
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", async () => {
			if (aborted) return;
			if (req.headers["x-mm-token"] !== proto.token) return reply(res, 403, { ok: false });
			let data;
			try {
				data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return reply(res, 400, { ok: false, error: "не JSON" });
			}
			if (!data || typeof data !== "object" || Array.isArray(data)) return reply(res, 400, { ok: false, error: "не JSON-объект" });
			const text = cleanText(data.text);
			if (!text) return reply(res, 400, { ok: false, error: "текст не подошёл" });
			const id = typeof data.id === "string" && /^w[0-9a-f]{4,16}$/.test(data.id) ? data.id : null;
			if (id && seen.get(id) === true) return reply(res, 200, { ok: true, duplicate: true });
			const t = now();
			// Повтор того, что мы уже приняли (Telegram не ответил), лимит второй раз не тратит.
			if (!(id && seen.has(id)) && !limiter.take(clientIp(req), t)) return reply(res, 429, { ok: false, error: "лимит заявок на сегодня" });
			const version = typeof data.v === "string" ? data.v.replace(/[^0-9a-zA-Z.\-]/g, "").slice(0, 20) : "";
			const message = `music_mentor · заявка\n\n${text}\n\n(${id ?? "без id"}${version ? ", версия " + version : ""})`;
			let forwarded = false;
			try {
				forwarded = await notify(message);
			} catch {}
			if (id) seen.set(id, forwarded);
			write({ at: new Date(t).toISOString(), id, v: version, forwarded, text });
			// Журнал есть, но автору не дошло: 502, клиент оставит заявку ждать и повторит.
			if (!forwarded) return reply(res, 502, { ok: false, error: "пересылка не удалась, повторю позже" });
			reply(res, 200, { ok: true });
		});
		req.on("error", () => {});
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const port = Number(process.env.WISH_PORT ?? 8793);
	const server = createReceiver({
		journal: process.env.WISH_JOURNAL || undefined,
		notify: process.env.WISH_NOTIFY ? notifyViaCommand(process.env.WISH_NOTIFY) : undefined,
	});
	server.listen(port, "127.0.0.1", () => console.log(`wish_receiver: 127.0.0.1:${port}`));
}
