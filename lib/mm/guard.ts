/**
 * Аварийный выключатель «своих функций» для start_mentor.cmd.
 *
 *   node guard.ts <код_выхода_pi> <время_старта_мс>
 *
 * Лаунчер зовёт нас, когда pi закончился с кодом ≠ 0. Если это случилось в первые секунды после старта и
 * пакет my_tools подключён, проверяем отдельным pi, он ли причина (расширение не загрузилось); если да —
 * убираем пакет из settings.json и возвращаем коду 10: лаунчер запустит pi ещё раз. Всё остальное
 * (Ctrl+C, обычный выход, чужая поломка) — код 0, лаунчер просто выходит.
 *
 * Печатаем одну строку по-русски: лаунчер до этого ставит кодовую страницу UTF-8.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { piCommand, probePi, setMyTools } from "./mytools.ts";
import { findMyToolsPackage, isMyToolsDisabled, readSettings, settingsPath } from "./pisettings.ts";
import { mmRoot } from "./session.ts";

export const GUARD_WINDOW_MS = 20_000;
export const EXIT_RETRY = 10;
export const MESSAGE = "Мои функции выключены — что-то в них сломалось, скажи агенту «почини мои функции».";

export interface GuardDeps {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	probe?: (extra: string[]) => Promise<{ ok: boolean; output: string }>;
	say?: (line: string) => void;
}

/** 0 — ничего не делали; EXIT_RETRY — пакет выключили, запусти pi заново. */
export async function guard(code: number, startedAt: number, deps: GuardDeps = {}): Promise<number> {
	const env = deps.env ?? process.env;
	const now = (deps.now ?? Date.now)();
	if (!Number.isFinite(code) || code === 0) return 0;
	if (!Number.isFinite(startedAt) || now - startedAt > GUARD_WINDOW_MS || now < startedAt) return 0;
	let pkg: string | undefined;
	try {
		pkg = findMyToolsPackage(readSettings(settingsPath(env)));
	} catch {
		return 0;
	}
	if (!pkg || isMyToolsDisabled(pkg)) return 0;
	const probe = deps.probe ?? ((extra: string[]) => probePi({ cmd: piCommand(env), env, extraExtensions: extra, lateMs: 1500 }));
	const r = await probe([]);
	if (r.ok) return 0; // pi упал не из-за наших функций
	const why = (r.output.split(/\r?\n/).find((l) => /Failed to load extension|Error/i.test(l)) ?? r.output.split(/\r?\n/)[0] ?? "").slice(0, 300);
	setMyTools(pkg, false, `pi не стартовал с my_tools (код ${code}): ${why}`, env);
	try {
		const dir = path.join(mmRoot(env), "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(path.join(dir, "my_tools_guard.log"), `${new Date().toISOString()} код ${code}: ${why}\n`, "utf8");
	} catch {
		// журнал не обязателен
	}
	(deps.say ?? ((l: string) => console.log(l)))(MESSAGE);
	return EXIT_RETRY;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invoked) {
	guard(Number(process.argv[2]), Number(process.argv[3])).then(
		(c) => process.exit(c),
		() => process.exit(0),
	);
}
