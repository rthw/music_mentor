/**
 * Чтение и правка settings.json pi со стороны агента: подключить или выключить пакет my_tools.
 * Тот же разбор делает PowerShell в lib/win/common.ps1 (Set-PiSettings) при установке и обновлении;
 * правила совпадают: чужие поля не трогаем, пакет — строка с абсолютным путём.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Каталог агента pi: PI_CODING_AGENT_DIR или ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const fixed = env.PI_CODING_AGENT_DIR?.trim();
	if (fixed) return fixed;
	return path.join(env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir(), ".pi", "agent");
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(piAgentDir(env), "settings.json");
}

export function readSettings(file: string): Record<string, any> {
	try {
		const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
		if (!raw.trim()) return {};
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? v : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`settings.json не разобрался: ${(err as Error).message}`);
	}
}

/** Запись через временный файл: обрыв посреди записи не оставит полфайла. */
export function writeSettings(file: string, s: Record<string, any>): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp${process.pid}`;
	writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
	try {
		renameSync(tmp, file);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			// нет так нет
		}
		throw err;
	}
}

export function normPath(p: string): string {
	return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sourceOf(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof (entry as any).source === "string") return (entry as any).source;
	return "";
}

/** Пути пакетов из settings.json (строки и объекты с source). */
export function packageSources(s: Record<string, any>): string[] {
	return (Array.isArray(s.packages) ? s.packages : []).map(sourceOf).filter(Boolean);
}

/** Пакет «свои функции» узнаём по хвосту пути learner/my_tools: рабочая папка у каждого своя. */
export function isMyToolsPath(p: string): boolean {
	return /(^|\/)learner\/my_tools$/.test(normPath(p));
}

export function findMyToolsPackage(s: Record<string, any>): string | undefined {
	return packageSources(s).find(isMyToolsPath);
}

/** Подключить (enabled) или убрать пакет my_tools; хвосты старых путей к той же папке чистим. Возвращает, менялся ли файл. */
export function setMyToolsInSettings(s: Record<string, any>, pkgDir: string, enabled: boolean): boolean {
	const before = JSON.stringify(s.packages ?? null);
	const rest = (Array.isArray(s.packages) ? s.packages : []).filter((e: unknown) => !isMyToolsPath(sourceOf(e)));
	s.packages = enabled ? [...rest, pkgDir] : rest;
	return JSON.stringify(s.packages) !== before;
}

/** Подключить папку рецептов как источник скиллов. */
export function setRecipesInSettings(s: Record<string, any>, recipesDir: string): boolean {
	const before = JSON.stringify(s.skills ?? null);
	const rest = (Array.isArray(s.skills) ? s.skills : []).filter((e: unknown) => !/(^|\/)learner\/recipes$/.test(normPath(String(e))));
	s.skills = [...rest, recipesDir];
	return JSON.stringify(s.skills) !== before;
}

/** Метка «функции выключены»: файл рядом с my_tools, внутри — причина (её читает агент). */
export function disabledFlag(pkgDir: string): string {
	return path.join(path.dirname(pkgDir), "my_tools_disabled");
}

export function isMyToolsDisabled(pkgDir: string): boolean {
	return existsSync(disabledFlag(pkgDir));
}
