/**
 * mentor_update — обновление наставника: git fetch --tags, checkout последнего стабильного тега, pi install,
 * переустановка моста. Вся работа в update.ps1 (тот же скрипт, что и у ярлыка «Обновить наставника»).
 * check_only=true только сравнивает текущий и последний теги и ничего не меняет.
 *
 * Тут же две тихие проверки — не чаще раза в сутки (см. lib/mm/session.ts): вышла ли новая версия
 * и не кончается ли баланс ключа DeepSeek. Вызывает их старт сессии (extensions/session_start.ts),
 * чтобы предупреждения попали в сводку первого хода, а не только в окно.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { markRun, mmRoot, shouldRunDaily, stampPath } from "../lib/mm/session.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Порог «скоро кончится» в валюте баланса. DeepSeek держит деньги в CNY, но отдаёт и USD.
 * Ориентир — цена урока-дня: 1 USD / 7 CNY, ниже — предупредить.
 */
export const BALANCE_MIN: Record<string, number> = { USD: 1, CNY: 7 };

/** Файл с ключом pi (deepseek.key). PI_CODING_AGENT_DIR — стандартная подмена каталога pi. */
export function authFile(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(dir, "auth.json");
}

export function readKey(file = authFile()): string | undefined {
	try {
		const auth = JSON.parse(readFileSync(file, "utf8"));
		const key = auth?.deepseek?.key;
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Предупреждение о балансе или undefined, если денег достаточно (или валюту не знаем). */
export function balanceWarning(json: any, min: Record<string, number> = BALANCE_MIN): string | undefined {
	const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
	for (const info of infos) {
		const currency = String(info?.currency ?? "").toUpperCase();
		const limit = min[currency];
		const amount = Number(info?.total_balance);
		if (!limit || !Number.isFinite(amount)) continue;
		if (amount >= limit) return undefined;
		return `На ключе DeepSeek осталось ${amount.toFixed(2)} ${currency} — скоро закончится. Скажи автору, чтобы пополнил.`;
	}
	return undefined;
}

export async function fetchBalance(key: string, base = process.env.MM_DEEPSEEK_API ?? "https://api.deepseek.com"): Promise<any> {
	const r = await fetch(`${base.replace(/\/+$/, "")}/user/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
	if (!r.ok) throw new Error(`DeepSeek ответил ${r.status}`);
	return await r.json();
}

export interface DailyDeps {
	root?: string;
	now?: Date;
	latest?: () => Promise<{ current?: string; latest?: string }>;
	balance?: () => Promise<any>;
	key?: () => string | undefined;
}

/** Не чаще раза в сутки: есть ли новая версия. Возвращает строку для ученика или undefined. */
export async function updateReminder(deps: DailyDeps = {}): Promise<string | undefined> {
	const now = deps.now ?? new Date();
	const file = stampPath(deps.root ?? mmRoot(), "last_update_check");
	if (!shouldRunDaily(file, now)) return undefined;
	markRun(file, now); // отметка до сети: без интернета не переспрашиваем на каждом старте
	try {
		const { current, latest } = await (deps.latest ?? (() => remoteLatest()))();
		if (!latest || current === latest) return undefined;
		return `Вышла новая версия наставника ${latest} (у тебя ${current ?? "неизвестная"}). Скажи «обнови наставника», когда будет удобно.`;
	} catch {
		return undefined;
	}
}

/** Не чаще раза в сутки: не кончается ли баланс. Возвращает строку для ученика или undefined. */
export async function balanceReminder(deps: DailyDeps = {}): Promise<string | undefined> {
	const now = deps.now ?? new Date();
	const file = stampPath(deps.root ?? mmRoot(), "last_balance_check");
	if (!shouldRunDaily(file, now)) return undefined;
	markRun(file, now);
	try {
		const key = (deps.key ?? (() => readKey()))();
		if (!key) return undefined;
		return balanceWarning(await (deps.balance ?? (() => fetchBalance(key)))());
	} catch {
		return undefined;
	}
}

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout, encoding: "utf8", windowsHide: true, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
			resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
		});
	});
}

/** Последний стабильный тег vX.Y.Z из списка (rc и прочие игнорируются). */
export function latestStableTag(tags: string[]): string | undefined {
	let best: { tag: string; v: number[] } | undefined;
	for (const t of tags) {
		const m = STABLE_TAG.exec(t.trim());
		if (!m) continue;
		const v = [Number(m[1]), Number(m[2]), Number(m[3])];
		if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) best = { tag: t.trim(), v };
	}
	return best?.tag;
}

export async function currentTag(dir = APP_DIR): Promise<string | undefined> {
	const r = await run("git", ["describe", "--tags", "--exact-match", "HEAD"], dir, 10_000);
	return r.code === 0 ? r.out.split("\n")[0].trim() : undefined;
}

export async function remoteLatest(dir = APP_DIR): Promise<{ current?: string; latest?: string }> {
	const f = await run("git", ["fetch", "--tags", "--force", "origin"], dir, 60_000);
	if (f.code !== 0) throw new Error(`Не получилось спросить сервер о новых версиях: ${f.out || "git fetch не удался"}`);
	const t = await run("git", ["tag", "--list", "v*"], dir, 10_000);
	return { current: await currentTag(dir), latest: latestStableTag(t.out.split("\n")) };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "mentor_update",
		label: "Обновить наставника",
		description:
			"Проверить и поставить новую версию наставника (код, мост к Live). check_only=true — только сказать, есть ли новая версия. После обновления нужно перезапустить наставника. Обновляй только по просьбе ученика.",
		promptSnippet: "Проверить или поставить новую версию наставника",
		parameters: Type.Object({
			check_only: Type.Optional(Type.Boolean({ description: "Только проверить, ничего не менять" })),
		}),
		async execute(_id: string, params: { check_only?: boolean }) {
			const { current, latest } = await remoteLatest();
			if (!latest) return text("На сервере нет стабильных версий наставника.", { current });
			if (current === latest) return text(`Установлена последняя версия (${latest}).`, { current, latest });
			if (params?.check_only) return text(`Есть новая версия: ${latest} (сейчас ${current ?? "неизвестно"}). Скажи ученику, что можно обновиться.`, { current, latest });
			if (process.platform !== "win32") throw new Error("Обновление через update.ps1 работает только в Windows.");
			const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(APP_DIR, "update.ps1"), "-NoPause"], APP_DIR, 300_000);
			if (r.code !== 0) throw new Error(`Обновление не получилось: ${r.out.slice(-1500)}`);
			return text(`Обновление до ${latest} выполнено. Попроси ученика закрыть наставника и открыть заново.\n${r.out.slice(-800)}`, { current, latest });
		},
	});
}
