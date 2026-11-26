/**
 * Тихий экран (T1909): свёрнутый вид инструмента — одна строка, раскрытый — полный вывод,
 * футер короткий и без служебных цифр.
 *
 * pi для этого не нужен: расширения регистрируют инструменты в поддельный API, рендеры зовутся
 * напрямую, а pi-tui подменяется заглушкой (tests/stubs/tui.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import "./stubs/packages.ts";

const quiet = await import("../lib/mm/quiet.ts");
const alsExt = await import("../extensions/als.ts");
const liveExt = await import("../extensions/live.ts");
const logExt = await import("../extensions/log.ts");
const updExt = await import("../extensions/update.ts");
const audioExt = await import("../extensions/audio.ts");
const quietExt = await import("../extensions/quiet.ts");

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const ctx = (args: any = {}, extra: any = {}) => ({ args, isError: false, keyHint: (key: string, what: string) => `ctrl+o ${what} (${key})`, ...extra });

function toolsOf(mod: any): Map<string, any> {
	const map = new Map<string, any>();
	mod.default({ registerTool: (t: any) => map.set(t.name, t), on: () => {}, registerToolRenderer: () => {} } as any);
	return map;
}

/** Строка свёрнутого вида: без переносов, без служебного. */
function assertCollapsed(node: any, what: string) {
	const lines = node.render(200);
	assert.equal(lines.length, 1, `${what}: свёрнутый вид — одна строка, а не простыня`);
	assert.ok(!lines[0].includes("\n"), `${what}: внутри строки перенос`);
	assert.match(lines[0], /^[✓✗] /, `${what}: нет знака итога`);
	assert.match(lines[0], /ctrl\+o подробности/, `${what}: нет подсказки Ctrl+O`);
}

const body = Array.from({ length: 60 }, (_, i) => `строка ${i + 1}: Аккорды Cmaj7 | Fmaj7 | G7`).join("\n");

test("project_analysis: свёрнуто — одна строка итога, раскрыто — весь текст", () => {
	const t = toolsOf(alsExt).get("project_analysis");
	const result = { content: [{ type: "text", text: `Анализ «Ночь.als»: 4 мелодических MIDI-треков с нотами.\n${body}` }] };
	const folded = t.renderResult(result, { expanded: false }, theme, ctx({}));
	assertCollapsed(folded, "project_analysis");
	assert.ok(!folded.render(200)[0].includes("Аккорды Cmaj7"), "в свёрнутом виде попали строки анализа");
	assert.match(folded.render(200)[0], /Анализ «Ночь\.als»/, "итог не из первой строки вывода");

	const open = t.renderResult(result, { expanded: true }, theme, ctx({}));
	const lines = open.render(200);
	assert.ok(lines.length >= 61, `раскрытый вид потерял вывод: строк ${lines.length}`);
	assert.match(open.text, /строка 60: Аккорды Cmaj7/, "в раскрытом виде нет конца вывода");
});

test("project_analysis: строка вызова по-русски, без JSON", () => {
	const t = toolsOf(alsExt).get("project_analysis");
	const call = t.renderCall({ path: "C:\\Users\\Друг\\Documents\\Проекты\\Ночь.als" }, theme, ctx({}));
	assertCollapsed; // вызов — не итог, знака нет
	assert.equal(call.render(200).length, 1);
	assert.match(call.render(200)[0], /Считаю теорию по нотам «Ночь»…/);
});

test("project_summary: итог из details — «4 трека, 100 BPM, Live 12.1.5»", () => {
	const t = toolsOf(alsExt).get("project_summary");
	const result = { content: [{ type: "text", text: "Сводка…" }], details: { tempo: 100, liveVersion: "12.1.5", tracks: 4 } };
	const folded = t.renderResult(result, { expanded: false }, theme, ctx({ path: "Ночь.als" }));
	assertCollapsed(folded, "project_summary");
	assert.match(folded.render(200)[0], /✓ 4 трека, 100 BPM, Live 12\.1\.5/);
});

test("ошибка — одна строка по-человечески, JSON и «Error:» не показываем", () => {
	const t = toolsOf(alsExt).get("project_analysis");
	const thrown = { content: [{ type: "text", text: "Error: Не удалось прочитать проект C:\\x\\Ночь.als: мусор в файле" }], isError: true };
	const folded = t.renderResult(thrown, { expanded: false }, theme, ctx({}));
	assertCollapsed(folded, "ошибка");
	assert.match(folded.render(200)[0], /^✗ Не удалось прочитать проект/, "текст ошибки испорчен");
	assert.ok(!folded.render(200)[0].includes("Error:"), "в свёрнутой ошибке остался «Error:»");

	const json = t.renderResult({ content: [{ type: "text", text: '{"error":"boom","stack":"…"}' }], isError: true }, { expanded: false }, theme, ctx({}));
	assert.equal(json.render(200).length, 1);
	assert.ok(!json.render(200)[0].includes("boom"), "JSON ошибки попал на экран");

	const open = t.renderResult(thrown, { expanded: true }, theme, ctx({}));
	assert.match(open.text, /мусор в файле/, "в раскрытом виде должен быть полный текст ошибки");
});

test("все инструменты расширений умеют тихий вид", () => {
	const result = { content: [{ type: "text", text: "готово" }], details: {} };
	for (const [mod, names] of [
		[alsExt, ["project_list", "project_summary", "clip_notes", "project_analysis", "project_diff"]],
		[liveExt, ["live_ping", "live_state", "live_clip_notes", "live_browser", "live_add_track", "live_add_clip", "live_load_device", "live_set_param", "live_remove", "live_play", "live_stop"]],
		[audioExt, ["audio_list", "audio_analyze", "audio_compare"]],
		[logExt, ["mentor_log"]],
		[updExt, ["mentor_update"]],
	] as const) {
		const tools = toolsOf(mod);
		for (const name of names) {
			const t = tools.get(name);
			assert.ok(t, `нет инструмента ${name}`);
			assert.equal(typeof t.renderCall, "function", `${name}: нет renderCall`);
			assert.equal(typeof t.renderResult, "function", `${name}: нет renderResult`);
			const call = t.renderCall({ path: "Ночь.als", name: "Бас", track: 1, slot: 0 }, theme, ctx({}));
			assert.equal(call.render(200).length, 1, `${name}: вызов не одной строкой`);
			assert.ok(!call.render(200)[0].includes("{" ) || !call.render(200)[0].includes('"'), `${name}: в вызове JSON`);
			const folded = t.renderResult(result, { expanded: false }, theme, ctx({ path: "Ночь.als", name: "Бас", track: 1, slot: 0 }));
			assert.equal(folded.render(200).length, 1, `${name}: итог не одной строкой`);
			assert.match(folded.render(200)[0], /^✓ /, `${name}: нет итога`);
		}
	}
});

test("встроенные инструменты: одна строка «Читаю профиль…», итог по-человечески", () => {
	const resolvers: any[] = [];
	quietExt.default({ registerToolRenderer: (r: any) => resolvers.push(r), on: () => {}, registerTool: () => {} } as any);
	assert.equal(resolvers.length, 1);

	const pick = (name: string, base: any = undefined) => resolvers[0](name, () => base);
	const read = pick("read");
	assert.match(read.renderCall({ path: "learner/profile.md" }, theme, ctx({})).render(200)[0], /^Читаю профиль…$/);
	const readResult = { content: [{ type: "text", text: "---\nname: Саша\n---\nлюбит эмбиент" }] };
	assert.match(read.renderResult(readResult, { expanded: false }, theme, ctx({ path: "learner/profile.md" })).render(200)[0], /^✓ профиль: 4 строки/);

	const write = pick("write");
	assert.match(write.renderCall({ path: "learner/profile.md", content: "x" }, theme, ctx({})).render(200)[0], /Записываю профиль…/);
	assert.match(write.renderResult({ content: [{ type: "text", text: "written" }] }, { expanded: false }, theme, ctx({ path: "learner/profile.md" })).render(200)[0], /✓ записал в профиль/);

	const bash = pick("bash");
	assert.match(bash.renderResult({ content: [{ type: "text", text: "ok\nexit code: 2" }] }, { expanded: false }, theme, ctx({ command: "ls" })).render(200)[0], /✗? ?команда вернула код 2/);
	assert.match(bash.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false }, theme, ctx({ command: "ls" })).render(200)[0], /✓ готово, 2 строки вывода/);

	// Раскрытый вид встроенного инструмента — родной рендер pi (подсветка, диффы), если он есть.
	const base = { renderResult: () => ({ render: () => ["ПОЛНЫЙ РЕНДЕР PI"] }) };
	const withBase = pick("edit", base);
	assert.deepEqual(withBase.renderResult({ content: [] }, { expanded: true }, theme, ctx({ path: "a.ts" })).render(200), ["ПОЛНЫЙ РЕНДЕР PI"]);
	// Нет родного рендера — показываем текст сами, а не пустоту.
	const text = pick("edit").renderResult({ content: [{ type: "text", text: "строка A\nстрока B" }] }, { expanded: true }, theme, ctx({ path: "a.ts" }));
	assert.match(text.text, /строка A\n.*строка B/);

	// Не наш инструмент — отдаём дальше, ничего не ломая.
	const other = resolvers[0]("project_analysis", () => ({ marker: 1 }));
	assert.deepEqual(other, { marker: 1 });
});

test("футер: «Агент · Ctrl+O — подробности» и предупреждения, без токенов и денег", () => {
	let factory: any;
	const fakeCtx = { hasUI: true, ui: { setFooter: (f: any) => (factory = f) } };
	assert.equal(quietExt.installFooter(fakeCtx), true);
	assert.equal(typeof factory, "function");

	const statuses = new Map<string, string>();
	const footerData = { getExtensionStatuses: () => statuses, onBranchChange: (cb: any) => () => cb };
	const comp = factory({ requestRender: () => {} }, theme, footerData);
	const line = comp.render(80);
	assert.equal(line.length, 1);
	assert.match(line[0], /^Агент · Ctrl\+O — подробности$/);
	assert.ok(!/[↑↓$]|CH\d|R\d+k/.test(line[0]), "в футере служебные цифры");

	statuses.set("mm", "Вышла новая версия агента v0.2.0");
	assert.match(comp.render(120)[0], /Агент · Ctrl\+O — подробности · Вышла новая версия агента v0\.2\.0/);

	// Без UI (печать, json) футер не ставим: нечего менять.
	assert.equal(quietExt.installFooter({ hasUI: false, ui: { setFooter: () => {} } }), false);
	assert.equal(quietExt.installFooter(undefined), false);
});

test("мысли модели: подпись у свёрнутого блока убрана (pi рисует «Thinking…»)", () => {
	let label: string | undefined = "Thinking...";
	const fakeCtx = { hasUI: true, ui: { setFooter: () => {}, setHiddenThinkingLabel: (l?: string) => (label = l) } };
	assert.equal(quietExt.hideThinkingLabel(fakeCtx), true);
	assert.equal(label, "", "подпись должна стать пустой — тогда строки нет совсем");
	assert.equal(quietExt.hideThinkingLabel({ hasUI: false, ui: {} }), false);
	assert.equal(quietExt.hideThinkingLabel(undefined), false);
});

test("quiet: служебные помощники", () => {
	assert.equal(quiet.oneLine("a\n\n b   c "), "a b c");
	assert.ok(quiet.oneLine("я".repeat(500), 20).length <= 20);
	assert.equal(quiet.projectName("C:\\Users\\Друг\\Documents\\Проекты\\Ночь.als"), "Ночь");
	assert.equal(quiet.friendlyFile("learner/log.jsonl"), "журнал занятий");
	assert.equal(quiet.friendlyFile("notes/упражнение.md"), "заметки");
	assert.equal(quiet.friendlyFile("~/Documents/Проекты/Оркестр.als"), "Оркестр");
	assert.equal(quiet.plural(1, "трек", "трека", "треков"), "1 трек");
	assert.equal(quiet.plural(4, "трек", "трека", "треков"), "4 трека");
	assert.equal(quiet.plural(12, "трек", "трека", "треков"), "12 треков");
	assert.equal(quiet.errorLine("Error: [read] файла нет"), "файла нет");
	assert.equal(quiet.errorLine('{"error":"x"}'), "не получилось, подробности — в раскрытом виде");
});
