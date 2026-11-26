/**
 * Тихое «раз в сутки» на старте сессии: новая версия наставника и баланс ключа.
 *
 * Между проверками проходит сутки, иначе каждая сессия ходила бы в сеть и дёргала ученика.
 * Отметки — обычные txt-файлы с ISO-датой в данных наставника (logs\ рядом, корень — mmRoot).
 * Любая ошибка проверки молчит: занятый урок не должен начинаться с сообщения об ошибке.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Каталог данных наставника (на Windows %LOCALAPPDATA%\music_mentor), MM_ROOT — для тестов. */
export function mmRoot(env: NodeJS.ProcessEnv = process.env): string {
	const fixed = env.MM_ROOT?.trim();
	if (fixed) return fixed;
	const base = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
	return path.join(base, "music_mentor");
}

/** Файл-отметка «это делали не позже суток назад». */
export function stampPath(root: string, name: string): string {
	return path.join(root, `${name}.txt`);
}

/** Пора ли снова (нет файла, дата битая или старше суток). */
export function shouldRunDaily(file: string, now: Date = new Date()): boolean {
	try {
		const t = Date.parse(readFileSync(file, "utf8").trim());
		if (Number.isFinite(t) && Math.abs(now.getTime() - t) < DAY_MS) return false;
	} catch {
		// нет файла — значит не делали
	}
	return true;
}

/** Записать отметку. Ошибка записи не должна ломать сессию. */
export function markRun(file: string, now: Date = new Date()): void {
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${now.toISOString()}\n`);
	} catch {
		// данных наставника нет прав — тихо
	}
}
