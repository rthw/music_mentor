/**
 * Тихий экран: как выглядит вызов инструмента, пока ученик не нажал Ctrl+O.
 *
 * Одна строка «что делаю» до вызова и одна строка «✓ что вышло» после — вместо простыни вывода.
 * Раскрытый вид (expanded) показывает тот же текст, что получила модель. Всё, что здесь лежит, —
 * чистые функции и маленькие компоненты: их проверяет tests/quiet.test.ts, pi для этого не нужен.
 */

import { Text } from "@earendil-works/pi-tui";

/** Тема pi: подмножество, которым пользуемся. */
export interface QuietTheme {
	fg(color: string, text: string): string;
}

/** Результат инструмента в том виде, в каком его видит pi. */
export interface QuietResult {
	content?: Array<{ type: string; text?: string }>;
	details?: any;
	isError?: boolean;
}

/** Клавиша раскрытия строк инструментов (см. docs/keybindings.md). */
export const EXPAND_HINT = "app.tools.expand";

/** Плоский текст результата: ровно то, что pi отдаёт модели. */
export function resultText(result?: QuietResult): string {
	return (result?.content ?? [])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** Одна строка: переносы и лишние пробелы схлопываются, длинное обрезается. */
export function oneLine(s: string, max = 110): string {
	const flat = String(s ?? "").replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Первая непустая строка текста. */
export function headLine(s: string): string {
	for (const line of String(s ?? "").split("\n")) if (line.trim()) return line.trim();
	return "";
}

/** Ошибка по-человечески: без «Error:», префиксов инструмента и JSON-потрохов. */
export function errorLine(s: string): string {
	const line = headLine(s)
		.replace(/^(Error|Ошибка|Tool failed)\s*[:：]?\s*/i, "")
		.replace(/^\[[^\]]{1,40}\]\s*/, "");
	// Голый JSON вместо текста — не показываем его ученику.
	if (/^[{}[\]]/.test(line) || /"error"\s*:/.test(line)) return "не получилось, подробности — в раскрытом виде";
	return oneLine(line, 140) || "не получилось";
}

/** Результат с ошибкой? Смотрим и флаг рендера, и текст (pi отдаёт ошибку и как текст). */
export function isErrorResult(result: QuietResult | undefined, isError?: boolean): boolean {
	if (isError) return true;
	if (result?.isError) return true;
	return /^(Error|Ошибка|Tool failed)\b/i.test(headLine(resultText(result)));
}

export interface QuietRowOptions {
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	keyHint?(keybinding: string, description: string): string;
}

/** Свёрнутая строка результата: «✓ итог (ctrl+o подробности)» или «✗ почему». */
export function resultRow(result: QuietResult | undefined, summary: string, opts: QuietRowOptions, theme: QuietTheme): Text {
	const body = resultText(result);
	const failed = isErrorResult(result, opts.isError);
	const head = oneLine(failed ? errorLine(body) || summary : summary) || (failed ? "не получилось" : "готово");
	if (opts.expanded) {
		let out = theme.fg(failed ? "error" : "success", (failed ? "✗ " : "✓ ") + head);
		for (const line of body.split("\n")) out += "\n" + theme.fg("dim", line);
		return new Text(out, 0, 0);
	}
	let out = theme.fg(failed ? "error" : "success", (failed ? "✗ " : "✓ ") + head);
	const hint = opts.keyHint?.(EXPAND_HINT, "подробности") ?? "";
	if (hint) out += theme.fg("dim", ` (${hint})`);
	return new Text(out, 0, 0);
}

/** Строка вызова: «Смотрю проект «Ночь»…». */
export function callRow(text: string, theme: QuietTheme): Text {
	return new Text(theme.fg("dim", oneLine(text, 120)), 0, 0);
}

/** Пока инструмент работает — одна точка, без вывода. */
export function partialRow(theme: QuietTheme): Text {
	return new Text(theme.fg("dim", "…"), 0, 0);
}

/**
 * Готовые рендеры для инструмента расширения: строка вызова и строка итога.
 * `summary` получает результат (там лежит `details`, по нему и строится итог).
 */
export function quietRender(call: (args: any) => string, summary: (result: QuietResult | undefined) => string) {
	return {
		renderCall(args: any, theme: QuietTheme) {
			return callRow(call(args), theme);
		},
		renderResult(result: QuietResult, options: QuietRowOptions, theme: QuietTheme, context: any) {
			if (options?.isPartial) return partialRow(theme);
			return resultRow(result, summary(result), { ...options, isError: context?.isError, keyHint: context?.keyHint }, theme);
		},
	};
}

// --- имена файлов и проектов по-человечески ------------------------------------------------

/** Путь к файлу ученика -> короткое имя, которое ему понятно. */
export function friendlyFile(p: unknown): string {
	const s = String(p ?? "").replace(/\\/g, "/");
	const base = s.split("/").filter(Boolean).pop() ?? s;
	if (/learner\/profile\.md$/i.test(s)) return "профиль";
	if (/learner\/log\.jsonl$/i.test(s)) return "журнал занятий";
	if (/learner\/snapshots\//i.test(s)) return "снимки проектов";
	if (/(^|\/)notes\//i.test(s)) return "заметки";
	if (/\.als$/i.test(s)) return projectName(s);
	return base || s;
}

/** «…/Ночь.als» -> «Ночь». */
export function projectName(p: unknown): string {
	const s = String(p ?? "").replace(/\\/g, "/");
	const base = s.split("/").filter(Boolean).pop() ?? s;
	return base.replace(/\.als$/i.test(base) ? /\.als$/i : /$^/, "") || base;
}

// --- встроенные инструменты ----------------------------------------------------------------

/** Встроенные инструменты pi, которым нужна тихая строка (тот же набор, что можно переопределять). */
export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "powershell", "ls", "grep", "find"] as const;

const cmd = (v: unknown) => oneLine(String(v ?? ""), 70);

/** Что встроенный инструмент делает — по-русски, одной строкой. */
export function builtinCall(tool: string, args: any): string {
	const a = args ?? {};
	switch (tool) {
		case "read":
			return `Читаю ${friendlyFile(a.path ?? a.file_path)}…`;
		case "write":
			return `Записываю ${friendlyFile(a.path ?? a.file_path)}…`;
		case "edit":
			return `Правлю ${friendlyFile(a.path ?? a.file_path)}…`;
		case "bash":
		case "powershell":
			return `Выполняю: ${cmd(a.command)}…`;
		case "ls":
			return `Смотрю папку ${friendlyFile(a.path) === a.path ? cmd(a.path) : friendlyFile(a.path)}…`;
		case "grep":
			return `Ищу «${cmd(a.query ?? a.pattern)}»…`;
		case "find":
			return `Ищу файлы ${cmd(a.pattern)}…`;
		default:
			return `${tool}…`;
	}
}

/** Русское число с правильным словом: plural(4, "трек", "трека", "треков") -> «4 трека». */
export const plural = (n: number, one: string, few: string, many: string) => {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
	return `${n} ${many}`;
};

/** Итог встроенного инструмента одной строкой: что ученик получил. */
export function builtinSummary(tool: string, result: QuietResult | undefined, args: any): string {
	const a = args ?? {};
	const body = resultText(result);
	const details = result?.details ?? {};
	const lines = body.split("\n").filter((l) => l.trim());
	switch (tool) {
		case "read": {
			const n = lines.length;
			const what = friendlyFile(a.path ?? a.file_path);
			const tail = details?.truncation?.truncated ? " (обрезано, в раскрытом — всё)" : "";
			return n === 0 ? `${what}: пусто` : `${what}: ${plural(n, "строка", "строки", "строк")}${tail}`;
		}
		case "write": {
			const what = friendlyFile(a.path ?? a.file_path);
			return what === "профиль" ? "записал в профиль" : what === "журнал занятий" ? "дописал журнал занятий" : `записал ${what}`;
		}
		case "edit": {
			const diff = String(details?.diff ?? "");
			if (!diff) return `поправил ${friendlyFile(a.path ?? a.file_path)}`;
			let plus = 0;
			let minus = 0;
			for (const l of diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) plus++;
				if (l.startsWith("-") && !l.startsWith("---")) minus++;
			}
			return `поправил ${friendlyFile(a.path ?? a.file_path)}: +${plus} / −${minus}`;
		}
		case "bash":
		case "powershell": {
			const m = /exit code: (\d+)/i.exec(body);
			const code = m ? Number(m[1]) : 0;
			if (code !== 0) return `команда вернула код ${code}`;
			return lines.length ? `готово, ${plural(lines.length, "строка", "строки", "строк")} вывода` : "готово, вывода нет";
		}
		case "ls":
			return lines.length ? plural(lines.length, "файл", "файла", "файлов") : "пусто";
		case "grep":
			return lines.length ? plural(lines.length, "совпадение", "совпадения", "совпадений") : "совпадений нет";
		case "find":
			return lines.length ? plural(lines.length, "файл", "файла", "файлов") : "ничего не нашлось";
		default:
			return oneLine(headLine(body) || "готово", 100);
	}
}
