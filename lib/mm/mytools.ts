/**
 * Песочница своих функций: пакет pi в learner/my_tools (extensions/*.ts), который агент дописывает
 * себе только по просьбе ученика.
 *
 * Почему learner/my_tools, а не %LOCALAPPDATA%\music_mentor\my_tools: папка learner/ уже «ученика» по
 * таблице Get-MmLearnerDirs — обновление её не перезаписывает, шаблон только досоздаёт; она в рабочей
 * папке агента (его cwd, ученик видит файлы), и тест «переживает обновление» — тот же, что для профиля.
 *
 * Битое расширение pi не пропускает молча: он завершается с кодом 1 (проверено на pi 1.5.0 для синтаксической
 * ошибки, исключения при загрузке и исключения из таймера). Поэтому после записи файла мы запускаем
 * отдельный pi (RPC, без запроса к модели) и откатываем файл, если тот не загрузился; а start_mentor.cmd
 * через lib/mm/guard.ts перезапускает pi без пакета, если он всё равно упал на старте.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { disabledFlag, isMyToolsDisabled, readSettings, setMyToolsInSettings, settingsPath, writeSettings } from "./pisettings.ts";

export function myToolsDir(workspace: string): string {
	return path.join(workspace, "learner", "my_tools");
}

export function extensionsDir(pkgDir: string): string {
	return path.join(pkgDir, "extensions");
}

const PACKAGE_JSON = {
	name: "mm-my-tools",
	version: "0.0.0",
	private: true,
	type: "module",
	description: "Свои функции ученика: расширения pi, которые агент дописал по его просьбе",
	pi: { extensions: ["./extensions"] },
};

/** Пакет создан (package.json + extensions/): шаблон кладёт их сам, это страховка. */
export function ensurePackage(pkgDir: string): void {
	mkdirSync(extensionsDir(pkgDir), { recursive: true });
	const pj = path.join(pkgDir, "package.json");
	if (!existsSync(pj)) writeFileSync(pj, JSON.stringify(PACKAGE_JSON, null, 2) + "\n", "utf8");
}

/** Имя файла функции: латиница, цифры, подчёркивание; начинается с буквы. */
export function validToolName(name: string): boolean {
	return typeof name === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(name);
}

export function listTools(pkgDir: string): string[] {
	try {
		return readdirSync(extensionsDir(pkgDir)).filter((f) => /\.(ts|js)$/.test(f)).sort();
	} catch {
		return [];
	}
}

// --- запуск pi для проверки -------------------------------------------------------------------

export interface PiCommand {
	file: string;
	args: string[];
	shell: boolean;
}

/**
 * Как запустить тот же pi, что и у ученика. MM_PI ставит start_mentor.cmd (путь к pi.cmd); иначе —
 * процесс, в котором мы работаем: узел с путём к скрипту pi или сам собранный pi.
 */
export function piCommand(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, script = process.argv[1]): PiCommand {
	const fixed = env.MM_PI?.trim();
	if (fixed) return { file: fixed, args: [], shell: /\.(cmd|bat)$/i.test(fixed) };
	const isRuntime = /^(node|bun)(\.exe)?$/i.test(path.basename(execPath));
	return { file: execPath, args: isRuntime && script ? [script] : [], shell: false };
}

export interface ProbeResult {
	ok: boolean;
	/** Что сказал pi про расширения (stderr), без ключей: ключи сюда не попадают. */
	output: string;
	code: number | null;
	timedOut?: boolean;
}

export interface ProbeOptions {
	cmd?: PiCommand;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Дополнительные расширения только для проверки (-e): когда my_tools выключен в settings. */
	extraExtensions?: string[];
	/** После ответа ждём, не упадёт ли расширение из таймера. */
	lateMs?: number;
	timeoutMs?: number;
}

/**
 * Запустить pi в RPC-режиме без сессии и спросить список команд: модель не вызывается, ключ не нужен.
 * Загрузка расширений происходит до ответа; упавшее расширение — «Failed to load extension» и код 1.
 */
export function probePi(opts: ProbeOptions = {}): Promise<ProbeResult> {
	const cmd = opts.cmd ?? piCommand(opts.env);
	const args = [...cmd.args, "--mode", "rpc", "--no-session"];
	for (const e of opts.extraExtensions ?? []) args.push("-e", e);
	const lateMs = opts.lateMs ?? 2500;
	const timeoutMs = opts.timeoutMs ?? 40_000;
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let answered = false;
		let timedOut = false;
		let done = false;
		const quote = (s: string) => (/[\s"]/.test(s) ? `"${s}"` : s);
		const child = cmd.shell
			// одна командная строка без массива аргументов: иначе node 22+ печатает DEP0190 прямо в окно агента
			? spawn([quote(cmd.file), ...args.map(quote)].join(" "), { cwd: opts.cwd, env: opts.env ?? process.env, shell: true, windowsHide: true })
			: spawn(cmd.file, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
		const finish = (code: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(killer);
			const loadFailed = /Failed to load extension|Не удалось загрузить расширение/i.test(err);
			const ok = answered && !loadFailed && !timedOut && (code === 0 || code === null);
			resolve({ ok, output: err.trim().slice(-2000), code, timedOut });
		};
		const killer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// уже вышел
			}
		}, timeoutMs);
		child.on("error", (e) => {
			err += `\nне запустился pi: ${e.message}`;
			finish(-1);
		});
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString("utf8");
			if (!answered && /"command"\s*:\s*"get_commands"/.test(out)) {
				answered = true;
				setTimeout(() => {
					try {
						child.stdin.end();
					} catch {
						// закрыт
					}
				}, lateMs);
			}
		});
		child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
		child.on("close", (code) => finish(code));
		try {
			child.stdin.write('{"type":"get_commands"}\n');
		} catch {
			// закрыт
		}
	});
}

// --- запись функции с откатом -------------------------------------------------------------------

export type Prober = (extra: string[]) => Promise<ProbeResult>;

export interface SaveToolResult {
	ok: boolean;
	message: string;
	file?: string;
	rolledBack?: boolean;
}

/**
 * Записать расширение и убедиться, что оно загружается. Не загрузилось — вернуть прежний файл
 * (или удалить новый) и отдать агенту текст ошибки pi, чтобы он поправил код и записал снова.
 */
export async function saveTool(pkgDir: string, name: string, code: string, probe: Prober): Promise<SaveToolResult> {
	if (!validToolName(name)) return { ok: false, message: "name: строчные латинские буквы, цифры и _ (например track_minutes), начинается с буквы" };
	const body = String(code ?? "");
	if (body.trim().length < 30) return { ok: false, message: "code пустой: нужен весь файл расширения" };
	if (body.length > 20_000) return { ok: false, message: "файл длиннее 20000 знаков: функция ученика должна быть маленькой" };
	if (!/export\s+default/.test(body)) return { ok: false, message: "в файле нет `export default function (pi) { … }` — pi не найдёт, что запускать" };
	ensurePackage(pkgDir);
	const file = path.join(extensionsDir(pkgDir), `${name}.ts`);
	const backup = `${file}.bak`;
	const had = existsSync(file);
	if (had) copyFileSync(file, backup);
	writeFileSync(file, body, "utf8");
	const disabled = isMyToolsDisabled(pkgDir);
	const r = await probe(disabled ? [file] : []);
	if (r.ok) {
		if (had) unlinkSync(backup);
		return { ok: true, file, message: `записал ${name}.ts, pi его загрузил` };
	}
	if (had) {
		copyFileSync(backup, file);
		unlinkSync(backup);
	} else {
		unlinkSync(file);
	}
	const why = r.timedOut ? "pi не ответил за 40 секунд" : r.output || `pi завершился с кодом ${r.code}`;
	return { ok: false, rolledBack: true, file, message: `расширение не загрузилось, файл откатил (${had ? "вернул прежнюю версию" : "удалил"}). Ответ pi:\n${why}` };
}

/** Убрать функцию (файл переименовывается в .removed, чтобы ученик мог вернуть). */
export function removeTool(pkgDir: string, name: string): boolean {
	const file = path.join(extensionsDir(pkgDir), `${name}.ts`);
	if (!existsSync(file)) return false;
	rmSync(`${file}.removed`, { force: true });
	copyFileSync(file, `${file}.removed`);
	unlinkSync(file);
	return true;
}

// --- выключатель -----------------------------------------------------------------------------------

/**
 * Включить или выключить пакет. Выключение — убрать его из settings.json и положить файл-метку с причиной;
 * метку видят и update.ps1 (не вернёт пакет сам), и агент (почините мои функции).
 */
export function setMyTools(pkgDir: string, enabled: boolean, reason = "", env: NodeJS.ProcessEnv = process.env): void {
	const file = settingsPath(env);
	const s = readSettings(file);
	const changed = setMyToolsInSettings(s, pkgDir, enabled);
	if (changed || !existsSync(file)) writeSettings(file, s);
	const flag = disabledFlag(pkgDir);
	if (enabled) rmSync(flag, { force: true });
	else writeFileSync(flag, `${reason || "выключено"}\n`, "utf8");
}

export function disabledReason(pkgDir: string): string | undefined {
	try {
		return readFileSync(disabledFlag(pkgDir), "utf8").trim() || "выключено";
	} catch {
		return undefined;
	}
}
