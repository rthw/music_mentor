/**
 * Заявки автору: ученик просит умение, которое не решается рецептом или маленькой функцией,
 * агент формулирует заявку, показывает её дословно и отправляет только после «да» ученика.
 *
 * Доставка — POST JSON на present.whimsical.work/api/wish (приёмник tools/wish/wish_receiver.mjs,
 * пересылает автору в Telegram). Токен в wish_proto.ts — не секрет: он лежит в открытом пакете.
 * Защита — лимит частоты, размер и отбрасывание мусора на стороне приёмника. Нет сети — заявка
 * ждёт в learner/wishes.md и уходит при следующем старте сессии (не чаще раза в сутки).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { proto } from "./wish_proto.ts";
import { markRun, mmRoot, shouldRunDaily, stampPath } from "./session.ts";

export { proto };

export function wishesFile(workspace: string): string {
	return path.join(workspace, "learner", "wishes.md");
}

export function newWishId(): string {
	return "w" + randomBytes(4).toString("hex");
}

// --- согласие ученика -----------------------------------------------------------------------------------

const YES = /^\s*(да|ага|угу|ок|окей|ok|okay|yes|yep|давай|отправляй|отправь|шли|пошли|отправить|согласен|согласна|конечно|валяй|погнали)(?![\p{L}\d])/iu;
const NO = /(^|[\s,.!;:—-])(не|нет|no|отмена|стоп|подожди|погоди|потом)([\s,.!;:—-]|$)/i;

/** «да» ученика: короткий ответ, начинается с согласия и без отрицания. Длинный ответ — это правка, а не «да». */
export function isYes(text: string): boolean {
	const t = String(text ?? "").trim();
	if (t.length === 0 || t.length > 40) return false;
	return YES.test(t) && !NO.test(t);
}

export interface Draft {
	text: string;
	/** Сколько сообщений ученика было к моменту черновика: «да» — следующее. */
	seq: number;
	/** Когда составлен (мс): старый черновик не отправляем. */
	at: number;
}

export interface GateState {
	seq: number;
	last: string;
	draft?: Draft;
}

export interface GateStore {
	load(): GateState;
	save(s: GateState): void;
}

/** Черновик живёт полчаса: «да» через день к вчерашней заявке не относится. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

/** Состояние замка в файле: переживает /reload и перезапуск процесса pi (разговор продолжается тем же «да»). */
export function fileGateStore(cwd: string, dir = tmpdir()): GateStore {
	const file = path.join(dir, `mm_wish_gate_${createHash("sha1").update(path.resolve(cwd).toLowerCase()).digest("hex").slice(0, 12)}.json`);
	return {
		load() {
			try {
				const v = JSON.parse(readFileSync(file, "utf8"));
				if (v && typeof v.seq === "number") return { seq: v.seq, last: String(v.last ?? ""), draft: v.draft };
			} catch {
				// нет файла — начинаем с нуля
			}
			return { seq: 0, last: "" };
		},
		save(s) {
			try {
				writeFileSync(file, JSON.stringify(s), "utf8");
			} catch {
				// без файла замок работает в памяти процесса
			}
		},
	};
}

/**
 * Замок согласия. Отправляем только дословный черновик, который ученик видел, и только если его
 * следующее сообщение — «да». Агент не может отправить сам: счётчик сообщений ученика ведёт pi
 * (событие input), а не модель.
 */
export class ConsentGate {
	private mem: GateState = { seq: 0, last: "" };
	private store: GateStore | undefined;
	private now: () => number;
	constructor(store?: GateStore, now: () => number = Date.now) {
		this.store = store;
		this.now = now;
	}

	private get(): GateState {
		return this.store ? this.store.load() : this.mem;
	}
	private put(s: GateState): void {
		if (this.store) this.store.save(s);
		else this.mem = s;
	}

	/** Сообщение ученика (не служебное). */
	onUserInput(text: string): void {
		const s = this.get();
		this.put({ ...s, seq: s.seq + 1, last: String(text ?? "") });
	}

	setDraft(text: string): Draft {
		const s = this.get();
		const draft = { text: String(text).trim(), seq: s.seq, at: this.now() };
		this.put({ ...s, draft });
		return draft;
	}

	cancel(): void {
		const s = this.get();
		this.put({ ...s, draft: undefined });
	}

	hasDraft(): boolean {
		return !!this.get().draft;
	}

	/** Можно ли отправлять: возвращает текст или причину отказа. */
	approve(): { ok: true; text: string } | { ok: false; reason: string } {
		const s = this.get();
		const d = s.draft;
		if (!d) return { ok: false, reason: "нет черновика: сначала action=draft и покажи текст ученику" };
		if (this.now() - d.at > DRAFT_TTL_MS) return { ok: false, reason: "черновик устарел: покажи заявку ещё раз и жди «да»" };
		if (s.seq <= d.seq) return { ok: false, reason: "ученик ещё не ответил на черновик: покажи ему текст и жди «да»" };
		if (s.seq > d.seq + 1) return { ok: false, reason: "после черновика ученик писал о другом: покажи заявку ещё раз и жди «да»" };
		if (!isYes(s.last)) return { ok: false, reason: `ученик не согласился (его ответ: «${s.last.slice(0, 60)}»): исправь заявку или отмени` };
		return { ok: true, text: d.text };
	}
}

// --- отправка и журнал -------------------------------------------------------------------------------------

export interface PostResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export interface PostDeps {
	fetch?: typeof fetch;
	url?: string;
	token?: string;
	timeoutMs?: number;
	version?: string;
}

export async function postWish(id: string, text: string, deps: PostDeps = {}): Promise<PostResult> {
	const f = deps.fetch ?? fetch;
	try {
		const r = await f(deps.url ?? process.env.MM_WISH_URL ?? proto.url, {
			method: "POST",
			headers: { "content-type": "application/json", "x-mm-token": deps.token ?? proto.token },
			body: JSON.stringify({ id, text, v: deps.version ?? "" }),
			signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
		});
		if (r.ok) return { ok: true, status: r.status };
		return { ok: false, status: r.status, error: `сервер ответил ${r.status}` };
	} catch (err) {
		return { ok: false, error: (err as Error).message || "нет сети" };
	}
}

export const PENDING = "ждёт отправки";
export const SENT = "отправлена";

export interface WishEntry {
	id: string;
	date: string;
	status: string;
	text: string;
}

function header(e: { date: string; id: string; status: string }): string {
	return `## ${e.date} · ${e.id} · ${e.status}`;
}

export function readWishes(workspace: string): WishEntry[] {
	let raw = "";
	try {
		raw = readFileSync(wishesFile(workspace), "utf8");
	} catch {
		return [];
	}
	const out: WishEntry[] = [];
	const parts = raw.split(/^## /m).slice(1);
	for (const p of parts) {
		const nl = p.indexOf("\n");
		const head = (nl < 0 ? p : p.slice(0, nl)).trim();
		const m = head.match(/^(.+?) · (w[0-9a-f]+) · (.+)$/);
		if (!m) continue;
		out.push({ date: m[1], id: m[2], status: m[3], text: (nl < 0 ? "" : p.slice(nl + 1)).trim() });
	}
	return out;
}

const FILE_HEAD = "# Заявки автору\n\nЗдесь все заявки, которые агент составил с твоего «да»: отправленные и те, что ждут сети. Файл твой, правки сохраняются.\n";

function appendWish(workspace: string, e: WishEntry): void {
	const file = wishesFile(workspace);
	mkdirSync(path.dirname(file), { recursive: true });
	if (!existsSync(file)) writeFileSync(file, FILE_HEAD, "utf8");
	appendFileSync(file, `\n${header(e)}\n\n${e.text}\n`, "utf8");
}

function setStatus(workspace: string, id: string, status: string): void {
	const file = wishesFile(workspace);
	const raw = readFileSync(file, "utf8");
	const re = new RegExp(`^(## .+ · ${id}) · .+$`, "m");
	writeFileSync(file, raw.replace(re, `$1 · ${status}`), "utf8");
}

export function nowLabel(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface SubmitResult {
	id: string;
	sent: boolean;
	error?: string;
}

/** Отправить заявку; не вышло — записать в wishes.md как ожидающую. В журнал она попадает в любом случае. */
export async function submitWish(workspace: string, text: string, deps: PostDeps & { now?: Date } = {}): Promise<SubmitResult> {
	const id = newWishId();
	const r = await postWish(id, text, deps);
	appendWish(workspace, { id, date: nowLabel(deps.now), status: r.ok ? SENT : PENDING, text });
	return { id, sent: r.ok, error: r.ok ? undefined : r.error };
}

/** Повторить ожидающие заявки: не чаще раза в сутки и только если они есть. Возвращает, сколько ушло. */
export async function retryPending(workspace: string, deps: PostDeps & { root?: string; now?: Date } = {}): Promise<{ tried: number; sent: number }> {
	const pending = readWishes(workspace).filter((w) => w.status === PENDING);
	if (pending.length === 0) return { tried: 0, sent: 0 };
	const stamp = stampPath(deps.root ?? mmRoot(), "wish_retry");
	if (!shouldRunDaily(stamp, deps.now)) return { tried: 0, sent: 0 };
	markRun(stamp, deps.now);
	let sent = 0;
	for (const w of pending) {
		const r = await postWish(w.id, w.text, deps);
		if (!r.ok) break; // сети нет — остальные тоже не уйдут
		setStatus(workspace, w.id, SENT);
		sent++;
	}
	return { tried: pending.length, sent };
}
