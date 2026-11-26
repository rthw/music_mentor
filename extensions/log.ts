/**
 * mentor_log — последний журнал установки, обновления или смены ключа.
 *
 * Журналы пишут install.ps1 / update.ps1 / change_key.ps1 в logs\ данных наставника
 * (см. lib/win/common.ps1, Start-MmLog). Ученик присылает автору файл, а не фотографию окна,
 * поэтому наставник должен уметь показать хвост журнала прямо в разговоре.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { mmRoot } from "../lib/mm/session.ts";

export const TAIL_LINES = 100;

/** Каталог журналов: <данные наставника>\logs. */
export function logsDir(root = mmRoot()): string {
	return path.join(root, "logs");
}

/** Самый свежий журнал в каталоге (по времени изменения) или undefined. */
export function latestLog(dir = logsDir()): string | undefined {
	try {
		let best: { file: string; time: number; name: string } | undefined;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".log")) continue;
			const file = path.join(dir, name);
			const s = statSync(file);
			if (!s.isFile()) continue;
			// При равном времени берём имя: в нём те же дата-время, и второй запуск не перетирает первый.
			if (!best || s.mtimeMs > best.time || (s.mtimeMs === best.time && name > best.name)) best = { file, time: s.mtimeMs, name };
		}
		return best?.file;
	} catch {
		return undefined;
	}
}

/** Последние n строк текста. */
export function tail(text: string, n = TAIL_LINES): string[] {
	const lines = text.split(/\r?\n/);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.slice(-n);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "mentor_log",
		label: "Журнал наставника",
		description:
			"Показать последний журнал установки, обновления или смены ключа и его путь. Вызывай, когда ученик присылает скриншот ошибки или говорит, что установка/обновление не прошли: попроси прислать этот файл в разговор до слов «ничего не работает».",
		promptSnippet: "Последний журнал установки/обновления и путь к файлу",
		parameters: Type.Object({
			lines: Type.Optional(Type.Number({ description: "Сколько последних строк показать (по умолчанию 100)" })),
		}),
		async execute(_id: string, params: { lines?: number }) {
			const n = Math.min(Math.max(Math.floor(Number(params?.lines) || TAIL_LINES), 1), 1000);
			const file = latestLog();
			if (!file) {
				return { content: [{ type: "text" as const, text: `Журналов пока нет (${logsDir()}). Значит установка без ошибок ещё не запускалась после обновления наставника.` }], details: { dir: logsDir() } };
			}
			let body: string;
			try {
				body = tail(readFileSync(file, "utf8"), n).join("\n");
			} catch (err) {
				throw new Error(`Журнал ${file} не читается: ${(err as Error).message}`);
			}
			return {
				content: [{ type: "text" as const, text: `Журнал: ${file}\n\n${body}` }],
				details: { file, lines: n },
			};
		},
	});
}
