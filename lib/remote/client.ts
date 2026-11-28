/**
 * Файлы ученика через мост (MM_REMOTE_FILES=1): pi на сервере, Live и диск — у ученика.
 *
 * Список — команда моста files_list; чтение — file_read кусками по 512 КБ в кэш
 * ~/.cache/music_mentor/remote/<hash(path)>-<size>-<mtime>.<ext>. Дальше код работает с путём к кэшу
 * как с обычным файлом (парсер .als и analyzeWav не знают про мост). Пути в ответах ученику остаются виндовыми.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeClosed, bridgeAddress, openSession, sendLine } from "../mm/bridge.ts";
import { cleanRemotePath, isWinAbsolute, winBase, winJoin } from "./paths.ts";

export const CHUNK = 512 * 1024;
export const CACHE_MAX_AGE_DAYS = 7;
export const CACHE_MAX_BYTES = 2 * 1024 ** 3;
const PARALLEL = 4;

export type FileKind = "als" | "wav";

export interface RemoteFile {
	path: string;
	size: number;
	mtime: number;
}

/** Моста нет: Live закрыт или Control Surface выключен. */
export class RemoteClosed extends Error {
	constructor() {
		super("Ableton Live не запущен или мост MentorBridge выключен: открой Live — без него я не вижу твоих файлов. Если мост ещё не включён, попроси меня проверить связь (live_ping): подскажу шаги.");
	}
}

export interface RemoteOpts {
	addr?: { host: string; port: number };
	cacheDir?: string;
}

export const cacheDirOf = (env: NodeJS.ProcessEnv = process.env) => env.MM_CACHE_DIR || path.join(homedir(), ".cache", "music_mentor", "remote");

/** Запрос к мосту: ok:false — исключение с текстом моста; закрытый порт — RemoteClosed. */
export async function bridgeCall(req: object, opts: RemoteOpts = {}): Promise<any> {
	let resp: any;
	try {
		resp = await sendLine(req, opts.addr ?? bridgeAddress());
	} catch (e) {
		throw e instanceof BridgeClosed ? new RemoteClosed() : e;
	}
	if (!resp.ok) throw new Error(resp.error ?? "мост вернул ошибку без текста");
	return resp.result;
}

export interface RemoteContext {
	home: string;
	roots: string[];
}

let ctxCache: { at: number; value: RemoteContext } | undefined;

/** Домашняя папка ученика и корни, которые отдаёт мост (без обхода диска). Домашняя нужна для `~` и коротких путей. */
export async function remoteContext(opts: RemoteOpts = {}): Promise<RemoteContext> {
	if (ctxCache && Date.now() - ctxCache.at < 60_000) return ctxCache.value;
	const r = await bridgeCall({ cmd: "files_list", kind: "als", roots_only: true }, opts);
	const value = { home: String(r.home ?? ""), roots: (r.roots ?? []) as string[] };
	ctxCache = { at: Date.now(), value };
	return value;
}

/** Для sync-нормализации путей: домашняя ученика, если уже знаем. */
export const knownRemoteHome = () => ctxCache?.value.home || undefined;
export const forgetRemoteContext = () => {
	ctxCache = undefined;
};

export async function listRemote(kind: FileKind, opts: RemoteOpts & { extra?: string[]; limit?: number } = {}): Promise<{ files: RemoteFile[]; roots: string[] }> {
	const r = await bridgeCall({ cmd: "files_list", kind, roots: opts.extra?.length ? opts.extra : undefined, limit: opts.limit }, opts);
	if (r.home) ctxCache = { at: Date.now(), value: { home: String(r.home), roots: r.roots ?? [] } };
	return { files: (r.files ?? []) as RemoteFile[], roots: (r.roots ?? []) as string[] };
}

const kindOf = (p: string): FileKind => (/\.wav$/i.test(p) ? "wav" : "als");

/** Путь ученика → полный путь на его диске. Полные пути не трогает; короткие («Документы\Ночь.als») ищет по его папкам. */
export async function resolveRemotePath(p: string, opts: RemoteOpts = {}): Promise<string> {
	const s = cleanRemotePath(p);
	if (isWinAbsolute(s) || s.startsWith("/")) return s;
	const ctx = await remoteContext(opts);
	const rel = s.replace(/^~[\\/]?/, "");
	const probe = async (full: string) => {
		try {
			await bridgeCall({ cmd: "file_read", path: full, offset: 0, length: 1 }, opts);
			return true;
		} catch (e) {
			if (e instanceof RemoteClosed) throw e;
			return false;
		}
	};
	const candidates = [...(ctx.home ? [winJoin(ctx.home, rel)] : []), ...ctx.roots.map((r) => winJoin(r, rel))];
	for (const c of candidates) if (await probe(c)) return c;
	// «Документы\Ночь.als», а папка на диске называется Documents: ищем по хвосту пути среди найденных файлов
	const { files } = await listRemote(kindOf(rel), { ...opts, limit: 2000 });
	const tail = rel.replace(/[\\/]+/g, "\\").toLowerCase();
	const byTail = files.filter((f) => f.path.toLowerCase().endsWith("\\" + tail));
	const hits = byTail.length ? byTail : files.filter((f) => winBase(f.path).toLowerCase() === winBase(tail)); // «Документы\\X.als» при папке Documents
	if (hits.length) return hits.sort((a, b) => b.mtime - a.mtime)[0].path;
	throw new Error(`Не нашёл у тебя файл «${p}». Покажи полный путь (C:\\Users\\…) или посмотри список через project_list / audio_list.`);
}

const hashOf = (p: string) => createHash("sha1").update(p.toLowerCase()).digest("hex").slice(0, 16);

export interface Fetched {
	local: string;
	cached: boolean;
	size: number;
	ms: number;
}

/** Скачать файл ученика в кэш (или взять из кэша, если size/mtime те же). */
export async function fetchRemote(remotePath: string, opts: RemoteOpts = {}): Promise<Fetched> {
	const t0 = Date.now();
	const dir = opts.cacheDir ?? cacheDirOf();
	mkdirSync(dir, { recursive: true });
	for (let attempt = 0; ; attempt++) {
		const head = await bridgeCall({ cmd: "file_read", path: remotePath, offset: 0, length: 1 }, opts);
		const size = Number(head.size);
		const mtime = Number(head.mtime);
		const ext = path.extname(remotePath.replace(/\\/g, "/")).toLowerCase() || ".bin";
		const name = `${hashOf(remotePath)}-${size}-${mtime}${ext}`;
		const local = path.join(dir, name);
		try {
			if (existsSync(local) && statSync(local).size === size) {
				const now = new Date();
				utimesSync(local, now, now);
				return { local, cached: true, size, ms: Date.now() - t0 };
			}
		} catch {
			// кэш не прочитался — качаем заново
		}
		try {
			await download(remotePath, local, size, mtime, opts);
		} catch (e) {
			if (attempt < 1 && e instanceof FileChanged) continue;
			throw e instanceof FileChanged ? new Error("Файл меняется во время загрузки (Live сохраняет?). Повтори через пару секунд.") : e;
		}
		pruneCache(dir, { keep: name });
		return { local, cached: false, size, ms: Date.now() - t0 };
	}
}

class FileChanged extends Error {}

async function download(remotePath: string, dest: string, size: number, mtime: number, opts: RemoteOpts): Promise<void> {
	const part = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part`;
	const fd = openSync(part, "w");
	const sessions = Array.from({ length: Math.min(PARALLEL, Math.max(1, Math.ceil(size / CHUNK))) }, () => openSession(opts.addr ?? bridgeAddress()));
	try {
		let next = 0;
		let received = 0;
		const chunks = Math.ceil(size / CHUNK);
		const work = async (s: (typeof sessions)[number]) => {
			for (;;) {
				const i = next++;
				if (i >= chunks) return;
				const offset = i * CHUNK;
				let resp: any;
				try {
					resp = await s.request({ cmd: "file_read", path: remotePath, offset, length: CHUNK });
				} catch (e) {
					throw e instanceof BridgeClosed ? new RemoteClosed() : e;
				}
				if (!resp.ok) throw new Error(resp.error ?? "мост вернул ошибку без текста");
				const r = resp.result;
				if (Number(r.size) !== size || Number(r.mtime) !== mtime) throw new FileChanged();
				const buf = Buffer.from(String(r.data), "base64");
				writeSync(fd, buf, 0, buf.length, offset);
				received += buf.length;
			}
		};
		await Promise.all(sessions.map(work));
		if (received !== size) throw new FileChanged();
		closeSync(fd);
		renameSync(part, dest);
	} catch (e) {
		try {
			closeSync(fd);
		} catch {
			// уже закрыт
		}
		rmSync(part, { force: true });
		throw e;
	} finally {
		for (const s of sessions) s.close();
	}
}

/** Кэш: старше 7 дней и сверх 2 ГБ (самые старые первыми) — удалить; брошенные .part — тоже. */
export function pruneCache(dir: string, opts: { keep?: string; maxAgeDays?: number; maxBytes?: number; now?: number } = {}): string[] {
	const now = opts.now ?? Date.now();
	const maxAge = (opts.maxAgeDays ?? CACHE_MAX_AGE_DAYS) * 86_400_000;
	const maxBytes = opts.maxBytes ?? CACHE_MAX_BYTES;
	const removed: string[] = [];
	let entries: { name: string; size: number; mtime: number }[] = [];
	try {
		entries = readdirSync(dir).flatMap((name) => {
			try {
				const st = statSync(path.join(dir, name));
				return st.isFile() ? [{ name, size: st.size, mtime: st.mtimeMs }] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return removed;
	}
	const drop = (e: { name: string }) => {
		try {
			unlinkSync(path.join(dir, e.name));
			removed.push(e.name);
		} catch {
			// занят или уже удалён
		}
	};
	const alive: typeof entries = [];
	for (const e of entries) {
		if (e.name === opts.keep) alive.push(e);
		else if (now - e.mtime > (e.name.endsWith(".part") ? 86_400_000 : maxAge)) drop(e);
		else if (!e.name.endsWith(".part")) alive.push(e);
	}
	let total = alive.reduce((n, e) => n + e.size, 0);
	for (const e of alive.sort((a, b) => a.mtime - b.mtime)) {
		if (total <= maxBytes) break;
		if (e.name === opts.keep) continue;
		drop(e);
		total -= e.size;
	}
	return removed;
}

/** Файл ученика → локальный путь для чтения: полный путь на его диске и путь в кэше. */
export async function localFile(p: string, opts: RemoteOpts = {}): Promise<{ shown: string; local: string }> {
	const shown = await resolveRemotePath(p, opts);
	const f = await fetchRemote(shown, opts);
	return { shown, local: f.local };
}
