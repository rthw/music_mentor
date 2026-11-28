/** Транспорт к мосту MentorBridge (TCP 127.0.0.1:9878, одна JSON-строка туда, одна обратно). Без зависимостей от pi. */

import net from "node:net";

export const DEFAULT_PORT = 9878;
const TIMEOUT_MS = 35_000;

export function bridgeAddress(env: NodeJS.ProcessEnv = process.env) {
	return { host: env.MM_LIVE_HOST || "127.0.0.1", port: Number(env.MM_LIVE_PORT) || DEFAULT_PORT };
}

export class BridgeClosed extends Error {}

/** Одна строка JSON туда, одна обратно. */
export function sendLine(req: object, addr = bridgeAddress(), timeoutMs = TIMEOUT_MS): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ host: addr.host, port: addr.port });
		const chunks: string[] = [];
		let answered = false;
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("Live не ответил за 35 секунд. Возможно, открыт модальный диалог (сохранение, ошибка) — закрой его и повтори."));
		}, timeoutMs);
		sock.setEncoding("utf8");
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (d: string) => {
			chunks.push(d);
			if (!d.includes("\n")) return;
			const buf = chunks.join("");
			const i = buf.indexOf("\n");
			clearTimeout(timer);
			answered = true;
			sock.end();
			try {
				resolve(JSON.parse(buf.slice(0, i)));
			} catch {
				reject(new Error("Мост ответил не JSON-ом: " + buf.slice(0, 200)));
			}
		});
		sock.on("error", (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ECONNRESET" ? new BridgeClosed(e.code) : e);
		});
		// туннель открыт, а за ним никого (Live закрыт): сервер сразу рвёт соединение без ответа
		sock.on("close", () => {
			if (answered) return;
			clearTimeout(timer);
			reject(new BridgeClosed("closed"));
		});
	});
}

/** Одно соединение на много запросов: ответы идут в порядке запросов (так мост читает строки). Для скачивания кусками. */
export interface BridgeSession {
	request(req: object): Promise<any>;
	close(): void;
}

export function openSession(addr = bridgeAddress(), timeoutMs = TIMEOUT_MS): BridgeSession {
	const sock = net.createConnection({ host: addr.host, port: addr.port });
	sock.setEncoding("utf8");
	const waiting: { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
	let buf = "";
	let dead: Error | undefined;
	const fail = (e: Error) => {
		dead ??= e;
		for (const w of waiting.splice(0)) {
			clearTimeout(w.timer);
			w.reject(dead);
		}
	};
	sock.on("data", (d: string) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			const w = waiting.shift();
			if (!w) continue;
			clearTimeout(w.timer);
			try {
				w.resolve(JSON.parse(line));
			} catch {
				w.reject(new Error("Мост ответил не JSON-ом: " + line.slice(0, 200)));
			}
		}
	});
	sock.on("error", (e: NodeJS.ErrnoException) => fail(e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" ? new BridgeClosed(e.code) : e));
	sock.on("close", () => fail(new Error("Мост закрыл соединение")));
	return {
		request(req) {
			if (dead) return Promise.reject(dead);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					sock.destroy();
					fail(new Error("Live не ответил за 35 секунд. Возможно, открыт модальный диалог (сохранение, ошибка) — закрой его и повтори."));
				}, timeoutMs);
				waiting.push({ resolve, reject, timer });
				sock.write(JSON.stringify(req) + "\n");
			});
		},
		close() {
			fail(new Error("сессия закрыта"));
			sock.destroy();
		},
	};
}
