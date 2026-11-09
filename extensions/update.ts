/**
 * mentor_update — обновление наставника: git fetch --tags, checkout последнего стабильного тега, pi install,
 * переустановка моста. Вся работа в update.ps1 (тот же скрипт, что и у ярлыка «Обновить наставника»).
 * check_only=true только сравнивает текущий и последний теги и ничего не меняет.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";

const APP_DIR = path.join(import.meta.dirname, "..");
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

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
