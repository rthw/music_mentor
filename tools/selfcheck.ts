// Самопроверка установщика: project_summary на встроенном проекте. Печатает сводку, при ошибке — код 1.
// Запуск: node tools/selfcheck.ts [путь.als]
import path from "node:path";
import { readProject } from "../lib/als/parse.ts";
import { summarize } from "../lib/als/summary.ts";

const file = process.argv[2] ?? path.join(import.meta.dirname, "..", "tests", "fixtures", "als", "12", "vm_session_chords.als");
try {
	const text = summarize(readProject(file));
	if (!/BPM/.test(text)) throw new Error("в сводке нет темпа");
	console.log(text);
} catch (e) {
	console.error(`project_summary не сработал: ${(e as Error).message}`);
	process.exitCode = 1;
}
