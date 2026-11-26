/**
 * Рецепты ученика: маленькие markdown-скиллы в learner/recipes/<имя>/SKILL.md.
 *
 * Агент записывает сюда удачные приёмы и упражнения именно для этого ученика. pi видит папку как
 * источник скиллов (настройка `skills` в settings.json — её ставят установщик и update.ps1), а
 * обновление агента папку `learner/` не перезаписывает (Get-MmLearnerDirs).
 * Чистые функции: tests/grow.test.ts, pi не нужен.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_RECIPES = 60;
export const MAX_BODY_CHARS = 4000;
export const MAX_DESCRIPTION_CHARS = 300;

/** Папка рецептов в рабочей папке ученика. */
export function recipesDir(workspace: string): string {
	return path.join(workspace, "learner", "recipes");
}

/** Имя скилла по правилам pi: строчные латинские буквы, цифры и дефисы, до 64 знаков. */
export function validRecipeName(name: string): boolean {
	return typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** Описание в одну строку; «: » и « #» рвут голый YAML-скаляр (ловушка T1907), поэтому заменяем. */
export function cleanDescription(s: string): string {
	return String(s ?? "")
		.replace(/\s+/g, " ")
		.replace(/:\s/g, " — ")
		.replace(/\s#/g, " №")
		.replace(/:$/, "")
		.trim();
}

/** Фронтматтер + тело. description — в двойных кавычках (JSON-строка — валидный YAML). */
export function recipeText(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
}

export interface RecipeInfo {
	name: string;
	description: string;
	file: string;
}

function parseFront(text: string): { name?: string; description?: string } {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^(name|description):\s*(.*)$/);
		if (!kv) continue;
		let v = kv[2].trim();
		if (v.startsWith('"')) {
			try {
				v = JSON.parse(v);
			} catch {
				v = v.replace(/^"|"$/g, "");
			}
		}
		out[kv[1] as "name" | "description"] = v;
	}
	return out;
}

export function listRecipes(workspace: string): RecipeInfo[] {
	const dir = recipesDir(workspace);
	const out: RecipeInfo[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const n of names.sort()) {
		const file = path.join(dir, n, "SKILL.md");
		if (!existsSync(file)) continue;
		const f = parseFront(readFileSync(file, "utf8"));
		out.push({ name: f.name ?? n, description: f.description ?? "", file });
	}
	return out;
}

const STOP = new Set(["когда", "этот", "если", "чтобы", "ученик", "ученика", "который", "после", "перед", "через"]);

/** Слова для сравнения «похоже ли»: корень до 5 знаков, служебные отброшены. */
function stems(s: string): Set<string> {
	const out = new Set<string>();
	for (const w of s.toLowerCase().match(/[a-zа-яё0-9]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w.slice(0, 5));
	return out;
}

/** Доля общих корней относительно меньшего набора (0..1). */
export function similarity(a: string, b: string): number {
	const x = stems(a);
	const y = stems(b);
	if (x.size === 0 || y.size === 0) return 0;
	let common = 0;
	for (const w of x) if (y.has(w)) common++;
	return common / Math.min(x.size, y.size);
}

export type SaveStatus = "created" | "updated" | "exists" | "similar" | "invalid" | "full";

export interface SaveResult {
	status: SaveStatus;
	message: string;
	name?: string;
	file?: string;
	other?: string;
}

/**
 * Записать рецепт. Без `overwrite` не затирает чужое имя и не заводит дубль по смыслу:
 * похожий рецепт (общих корней ≥ 60%) — отказ с его именем, чтобы агент обновил его, а не плодил копии.
 */
export function saveRecipe(workspace: string, input: { name: string; description: string; body: string; overwrite?: boolean }): SaveResult {
	const name = String(input.name ?? "").trim();
	const description = cleanDescription(input.description);
	const body = String(input.body ?? "").trim();
	if (!validRecipeName(name)) return { status: "invalid", message: "name: только строчные латинские буквы, цифры и дефисы (например sidechain-kick), до 64 знаков" };
	if (description.length < 20) return { status: "invalid", message: "description короткий: одной фразой скажи, что это и когда открывать (от 20 знаков)" };
	if (description.length > MAX_DESCRIPTION_CHARS) return { status: "invalid", message: `description длиннее ${MAX_DESCRIPTION_CHARS} знаков: сократи до одной фразы` };
	if (body.length < 20) return { status: "invalid", message: "тело рецепта пустое: напиши сам приём или упражнение" };
	if (body.length > MAX_BODY_CHARS) return { status: "invalid", message: `тело длиннее ${MAX_BODY_CHARS} знаков: рецепт — это короткая заметка` };
	if (/^---\s*$/m.test(body)) return { status: "invalid", message: "в теле нет строки из трёх дефисов: она ломает фронтматтер" };

	const dir = recipesDir(workspace);
	const file = path.join(dir, name, "SKILL.md");
	const existing = listRecipes(workspace);
	const same = existsSync(file);
	if (same && !input.overwrite) return { status: "exists", name, file, message: `рецепт ${name} уже есть: обнови его (overwrite=true), если приём стал точнее, или выбери другое имя` };
	if (!same) {
		if (existing.length >= MAX_RECIPES) return { status: "full", message: `рецептов уже ${existing.length}: сведи близкие в один и удали лишнее, потом записывай новый` };
		for (const r of existing) {
			if (similarity(`${name.replace(/-/g, " ")} ${description}`, `${r.name.replace(/-/g, " ")} ${r.description}`) >= 0.6) {
				return { status: "similar", other: r.name, message: `похожий рецепт уже есть: ${r.name} («${r.description}»). Обнови его (name=${r.name}, overwrite=true) вместо дубля` };
			}
		}
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, recipeText(name, description, body), "utf8");
	return { status: same ? "updated" : "created", name, file, message: `${same ? "обновил" : "записал"} рецепт ${name}` };
}
