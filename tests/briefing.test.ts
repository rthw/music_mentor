/**
 * Старт сессии: сводка для первого хода (профиль, проекты, изменение, идея из журнала), шаблоны
 * профиля и журнала. Сеть не нужна: предупреждения подставляем заглушкой.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import "./stubs/packages.ts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


const br = await import("../lib/mm/briefing.ts");
const start = await import("../extensions/session_start.ts");

const ROOT = path.join(import.meta.dirname, "..");
const TEMPLATE = path.join(ROOT, "template");
const FIXTURE_ALS = path.join(import.meta.dirname, "fixtures", "als", "12", "vm_session_chords.als");

const tmp = () => mkdtempSync(path.join(tmpdir(), "mm-brief-"));

/** Рабочая папка ученика: копия шаблона (как её делает установщик). */
function workspace(opts: { profile?: string; log?: string } = {}): string {
	const dir = tmp();
	mkdirSync(path.join(dir, "learner"), { recursive: true });
	writeFileSync(path.join(dir, "AGENTS.md"), readFileSync(path.join(TEMPLATE, "AGENTS.md")));
	writeFileSync(path.join(dir, "learner", "profile.md"), opts.profile ?? readFileSync(path.join(TEMPLATE, "learner", "profile.md")));
	writeFileSync(path.join(dir, "learner", "log.jsonl"), opts.log ?? "");
	return dir;
}

test("шаблон профиля и журнала на месте и пустой профиль — это «первая сессия»", () => {
	assert.ok(existsSync(path.join(TEMPLATE, "learner", "profile.md")), "нет template/learner/profile.md");
	assert.ok(existsSync(path.join(TEMPLATE, "learner", "log.jsonl")), "нет template/learner/log.jsonl");
	assert.ok(existsSync(path.join(TEMPLATE, "AGENTS.md")));
	const text = readFileSync(path.join(TEMPLATE, "learner", "profile.md"), "utf8");
	assert.match(text, /^---\nname: ""/);
	for (const key of ["interests", "goals", "likes", "live", "level", "updated"]) assert.match(text, new RegExp(`^${key}:`, "m"), `нет поля ${key}`);
	assert.match(text, /## Узлы и статусы/);
	assert.match(text, /не встречал \/ видел \/ пробовал \/ владеет/);
	const p = br.parseProfile(text);
	assert.equal(br.isEmptyProfile(p), true, "шаблон должен читаться как пустой профиль");
	// Роль в AGENTS.md ссылается на скилл и не просит картинок.
	const agents = readFileSync(path.join(TEMPLATE, "AGENTS.md"), "utf8");
	assert.match(agents, /скилл[е]? `mentor`/);
	assert.match(agents, /не проси скриншот/i);
});

test("профиль: фронтматтер, кратко и статусы с доказательством", () => {
	const profile = br.parseProfile(`---
name: "Макс"
interests: ["даб-техно", "Bonobo"]
goals: ["доделать трек «Ночь»"]
likes: ["низкий бас"]
live: "Live 12 Suite"
level: "уверенный новичок"
updated: "2026-11-26"
---

# Профиль

## Кратко
(пока пусто)
Любит низкие басы, боится теории.

## Узлы и статусы

| тема | статус | доказательство |
|---|---|---|
| септаккорды | пробовал | «Ночь», 2026-11-20 |
| синкопы | видел | — |
| голосоведение | выучил | — |
`);
	assert.equal(br.isEmptyProfile(profile), false);
	assert.equal(profile.name, "Макс");
	assert.deepEqual(profile.interests, ["даб-техно", "Bonobo"]);
	assert.equal(profile.live, "Live 12 Suite");
	assert.match(profile.summary, /Любит низкие басы/);
	assert.ok(!profile.summary.includes("пока пусто"), "заглушка в скобках не должна попадать в выжимку");
	assert.deepEqual(profile.nodes.map((n) => n.topic), ["септаккорды", "синкопы"], "неизвестный статус в таблицу не попадает");
	assert.equal(profile.nodes[0].evidence, "«Ночь», 2026-11-20");
});

test("журнал: идея берётся из последней валидной строки, битые строки пропускаются", () => {
	assert.equal(br.lastLogEntry(""), undefined);
	assert.equal(br.lastLogEntry(undefined), undefined);
	assert.equal(br.lastLogEntry('{"date":"2026-11-20","next":"модуляция"}\nмусор\n')?.next, "модуляция", "последняя строка битая — берём предыдущую");
	const e = br.lastLogEntry('{"date":"2026-11-20","next":"модуляция"}\nмусор\n{"date":"2026-11-25","did":"аккорды","worked":"Gm7","next":"синкопы"}');
	assert.equal(e?.next, "синкопы");
	assert.equal(e?.date, "2026-11-25");
});

test("сводка: пустой профиль — знакомство, без проектов и журнала", async () => {
	const dir = workspace();
	const b = await br.buildBriefing(dir, { roots: [path.join(dir, "нет-такой-папки")], warnings: async () => [] });
	assert.equal(b.firstSession, true);
	assert.match(b.text, /## Профиль/);
	assert.match(b.text, /вы ещё не знакомы/);
	assert.match(b.text, /Познакомься по скиллу `mentor`/);
	assert.match(b.text, /пяти вопросов по одному/);
	assert.match(b.text, /Проектов `\.als` не нашлось/);
	assert.match(b.text, /Журнала сессий ещё нет/);
	assert.match(b.text, /Сначала знакомство/);
});

test("сводка: профиль, свежий проект, изменение и идея из журнала — наблюдение + следующий шаг", async () => {
	const dir = workspace({
		profile: `---\nname: "Макс"\ninterests: ["даб-техно"]\ngoals: ["доделать «Ночь»"]\nlive: "Live 12 Suite"\nlevel: "новичок"\n---\n\n## Кратко\nЛюбит низкий бас.\n\n## Узлы и статусы\n| тема | статус | доказательство |\n|---|---|---|\n| септаккорды | пробовал | «Ночь», 2026-11-20 |\n`,
		log: '{"date":"2026-11-25","did":"аккорды","worked":"Gm7","next":"попробовать модуляцию в бридж"}\n',
	});
	const projectsDir = path.join(dir, "проекты");
	mkdirSync(projectsDir);
	copyFileSync(FIXTURE_ALS, path.join(projectsDir, "Ночь.als"));
	const b = await br.buildBriefing(dir, { roots: [projectsDir], warnings: async () => [] });
	assert.equal(b.firstSession, false);
	assert.match(b.text, /Имя: Макс/);
	assert.match(b.text, /Live: Live 12 Suite/);
	assert.match(b.text, /Темы: септаккорды — пробовал \(«Ночь», 2026-11-20\)/);
	assert.match(b.text, /Ночь\.als/);
	assert.match(b.text, /### Что изменилось в «Ночь» с прошлого раза/);
	assert.match(b.text, /первый: сравнивать не с чем/);
	assert.match(b.text, /попробовать модуляцию в бридж/);
	assert.match(b.text, /конкретного наблюдения про его музыку/);
	assert.ok(existsSync(path.join(dir, "learner", "snapshots", "Ночь.json")), "снимок проекта должен лечь в learner/snapshots");

	// Второй раз снимок уже есть: в сводке сравнение, а не «первый».
	const again = await br.buildBriefing(dir, { roots: [projectsDir], warnings: async () => [] });
	assert.match(again.text, /ничего не изменилось/);
});

test("сводка: предупреждения о версии и балансе попадают в текст, зависшая сеть их не держит", async () => {
	const dir = workspace();
	const b = await br.buildBriefing(dir, { roots: [], warnings: async () => ["Вышла новая версия v0.2.0", undefined, "баланс 2.00 CNY"] });
	assert.match(b.text, /## Предупреждения/);
	assert.match(b.text, /v0\.2\.0/);
	assert.match(b.text, /2\.00 CNY/);
	assert.equal(b.warnings.length, 2);

	const began = Date.now();
	const slow = await br.buildBriefing(dir, {
		roots: [],
		warnings: () => new Promise((resolve) => setTimeout(() => resolve(["поздно"]), 3000)),
		warningTimeoutMs: 50,
	});
	assert.ok(Date.now() - began < 2000, "сводка не должна ждать сеть");
	assert.doesNotMatch(slow.text, /поздно/);

	const broken = await br.buildBriefing(dir, {
		roots: [],
		warnings: async () => {
			throw new Error("нет сети");
		},
	});
	assert.doesNotMatch(broken.text, /## Предупреждения/);
});

test("session_start: сводка уходит в контекст первого хода один раз за сессию", async () => {
	const dir = workspace();
	const handlers: Record<string, Function[]> = {};
	const pi = { on: (name: string, fn: Function) => (handlers[name] ??= []).push(fn) } as any;
	const notes: string[] = [];
	const ctx = { cwd: dir, ui: { notify: (t: string) => notes.push(t) } };
	start.default(pi, {
		build: async () =>
			({
				text: "СВОДКА-ТЕСТ",
				firstSession: true,
				warnings: ["мало денег"],
				projects: [],
			}) as any,
	});
	assert.equal(handlers.session_start?.length, 1);
	assert.equal(handlers.before_agent_start?.length, 1);
	handlers.session_start[0]({ reason: "startup" }, ctx);
	const first = await handlers.before_agent_start[0]({ messageType: "user", prompt: "привет" }, ctx);
	assert.equal(first?.message.content, "СВОДКА-ТЕСТ");
	assert.equal(first?.message.customType, "mentor-briefing");
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(notes, ["мало денег"], "предупреждения показываются и в окне");
	assert.equal(await handlers.before_agent_start[0]({ messageType: "user", prompt: "ещё" }, ctx), undefined, "второй ход — без сводки");
	assert.equal(await handlers.before_agent_start[0]({ messageType: "custom" }, ctx), undefined);

	// Новая сессия — снова первая.
	handlers.session_start[0]({ reason: "new" }, ctx);
	assert.equal((await handlers.before_agent_start[0]({ messageType: "user", prompt: "привет" }, ctx))?.message.content, "СВОДКА-ТЕСТ");
});
