/**
 * Скиллы пакета: pi читает `SKILL.md` из каталогов, объявленных в `pi.skills` package.json.
 * Молчаливо выпавший скилл (например из-за двоеточия с пробелом в неэкранированном `description`)
 * не виден в сессии и не даёт никакой ошибки — поэтому проверяем фронтматтер сами.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

function frontmatter(text: string): string[] {
	const m = text.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(m, "нет фронтматтера в начале файла");
	return m![1].split("\n");
}

function field(lines: string[], key: string): string | undefined {
	const line = lines.find((l) => l.startsWith(`${key}:`));
	if (line === undefined) return undefined;
	return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1");
}

const skillDirs = readdirSync(path.join(ROOT, "skills")).filter((name) => statSync(path.join(ROOT, "skills", name)).isDirectory());

test("package.json объявляет скиллы пакета, и они на месте", () => {
	assert.deepEqual(pkg.pi?.skills, ["./skills"]);
	assert.deepEqual(pkg.pi?.extensions, ["./extensions"]);
	assert.ok(skillDirs.includes("mentor"), "нет каталога skills/mentor");
});

for (const dir of skillDirs) {
	const file = path.join(ROOT, "skills", dir, "SKILL.md");
	const lines = frontmatter(readFileSync(file, "utf8"));

	test(`скилл ${dir}: фронтматтер разбирается и скилл не выпадет молча`, () => {
		assert.equal(field(lines, "name"), dir, "name во фронтматтере должен совпадать с каталогом");
		const description = field(lines, "description");
		assert.ok(description, "нет description — pi такой скилл не покажет");
		assert.ok(description!.length >= 20, "description слишком короткий, модель не поймёт, когда его открывать");
		assert.ok(description!.length <= 1024, "pi отбрасывает description длиннее 1024 символов");
		// Неэкранированное «: » в YAML-скаляре рвёт разбор — скилл исчезает из сессии без ошибки.
		assert.doesNotMatch(description!, /:\s/, "в description двоеточие с пробелом: возьми тире или кавычки");
	});
}

test("AGENTS.md ссылается на существующий скилл", () => {
	const agents = readFileSync(path.join(ROOT, "template", "AGENTS.md"), "utf8");
	for (const dir of skillDirs) assert.match(agents, new RegExp(`\`${dir}\``), `AGENTS.md не упоминает скилл ${dir}`);
});
