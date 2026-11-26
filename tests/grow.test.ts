/**
 * Агент растёт (T1914): рецепты, песочница своих функций с откатом и выключателем, заявки автору
 * (согласие, офлайн-очередь, приёмник с лимитами). Настоящий pi и сеть не нужны: pi подменён скриптом,
 * Telegram — функцией.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import "./stubs/packages.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const rec = await import("../lib/mm/recipes.ts");
const mt = await import("../lib/mm/mytools.ts");
const ps = await import("../lib/mm/pisettings.ts");
const guardMod = await import("../lib/mm/guard.ts");
const wish = await import("../lib/mm/wish.ts");
const growExt = await import("../extensions/grow.ts");
const wishExt = await import("../extensions/wish.ts");
const receiver = await import("../tools/wish/wish_receiver.mjs");

const tmp = (p = "mm-grow-") => mkdtempSync(path.join(tmpdir(), p));
const ws = () => {
	const w = tmp("mm-ws-");
	mkdirSync(path.join(w, "learner"), { recursive: true });
	return w;
};

const GOOD = {
	name: "sidechain-kick",
	description: "Как сделать сайдчейн бочки на басу в Live: Compressor с боковой цепью",
	body: "1. На басу вставь Compressor.\n2. Включи Sidechain и выбери трек с бочкой.\n3. Ratio 4:1, Release около 100 мс.",
};

// --- рецепты --------------------------------------------------------------------------------------------

test("рецепт: запись, фронтматтер без голого «: », повторное имя и похожий смысл не плодят дубли", () => {
	const w = ws();
	const r = rec.saveRecipe(w, GOOD);
	assert.equal(r.status, "created");
	const text = readFileSync(r.file!, "utf8");
	assert.match(text, /^---\nname: sidechain-kick\ndescription: ".+"\n---\n/);
	const front = text.split("\n---")[0].split("\n").slice(1);
	assert.deepEqual(front.map((l) => l.split(":")[0]), ["name", "description"], "во фронтматтере только name и description");
	assert.doesNotMatch(front[1].replace(/^description: /, "").slice(1, -1), /:\s/, "в описании нет «: »");
	assert.equal(rec.listRecipes(w).length, 1);
	assert.equal(rec.listRecipes(w)[0].description, GOOD.description.replace(/:\s/g, " — "), "«: » в описании заменено тире");

	assert.equal(rec.saveRecipe(w, GOOD).status, "exists");
	const again = rec.saveRecipe(w, { ...GOOD, name: "kick-sidechain-bass", description: "Сайдчейн бочки на басу в Live через Compressor" });
	assert.equal(again.status, "similar", again.message);
	assert.equal(again.other, "sidechain-kick");
	assert.equal(rec.saveRecipe(w, { ...GOOD, body: GOOD.body + "\n4. Проверь на мониторах.", overwrite: true }).status, "updated");
	assert.equal(rec.listRecipes(w).length, 1);
	// другой по смыслу — записывается
	assert.equal(rec.saveRecipe(w, { name: "bass-octave-jump", description: "Упражнение: прыжок баса на октаву на сильной доле", body: "Сдвинь бас в такте 3 на октаву вверх и послушай грув. Верни, если стало мутно." }).status, "created");
});

test("рецепт: плохие имена, пустое тело и фронтматтер-ловушки отклоняются", () => {
	const w = ws();
	for (const name of ["Sidechain", "side_chain", "рецепт", "-a", "a--b", "x".repeat(65), ""]) assert.equal(rec.saveRecipe(w, { ...GOOD, name }).status, "invalid", name);
	assert.equal(rec.saveRecipe(w, { ...GOOD, description: "коротко" }).status, "invalid");
	assert.equal(rec.saveRecipe(w, { ...GOOD, body: "мало" }).status, "invalid");
	assert.equal(rec.saveRecipe(w, { ...GOOD, body: GOOD.body + "\n---\nещё" }).status, "invalid");
	assert.equal(rec.saveRecipe(w, { ...GOOD, body: "я".repeat(5000) }).status, "invalid");
	assert.equal(rec.cleanDescription("Что: это # потом:"), "Что — это № потом");
});

// --- settings.json --------------------------------------------------------------------------------------

test("settings.json: пакет my_tools включается и выключается, чужие поля и пакеты целы", () => {
	const w = ws();
	const pkg = mt.myToolsDir(w);
	const s: Record<string, any> = { quietStartup: true, packages: ["/app/music_mentor", { source: "npm:x", skills: [] }] };
	assert.equal(ps.setMyToolsInSettings(s, pkg, true), true);
	assert.deepEqual(s.packages, ["/app/music_mentor", { source: "npm:x", skills: [] }, pkg]);
	assert.equal(ps.setMyToolsInSettings(s, pkg, true), false, "повтор ничего не меняет");
	assert.equal(ps.findMyToolsPackage(s), pkg);
	ps.setMyToolsInSettings(s, pkg, false);
	assert.deepEqual(s.packages, ["/app/music_mentor", { source: "npm:x", skills: [] }]);
	assert.equal(s.quietStartup, true);
	// рабочая папка переехала: старый путь заменяется, дубля нет
	ps.setMyToolsInSettings(s, "C:\\Old\\learner\\my_tools", true);
	ps.setMyToolsInSettings(s, pkg, true);
	assert.equal(s.packages.filter((p: any) => typeof p === "string" && /my_tools$/.test(p)).length, 1);
	const sk: Record<string, any> = { skills: ["/other"] };
	ps.setRecipesInSettings(sk, "/w/learner/recipes");
	ps.setRecipesInSettings(sk, "/w/learner/recipes");
	assert.deepEqual(sk.skills, ["/other", "/w/learner/recipes"]);
});

test("setMyTools: выключение убирает пакет и кладёт метку с причиной, включение возвращает", () => {
	const w = ws();
	const pkg = mt.myToolsDir(w);
	const agent = tmp("mm-agent-");
	const env = { PI_CODING_AGENT_DIR: agent } as NodeJS.ProcessEnv;
	writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["/app"], theme: "dark" }));
	mt.setMyTools(pkg, true, "", env);
	assert.deepEqual(JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8")).packages, ["/app", pkg]);
	mt.setMyTools(pkg, false, "сломалось", env);
	const after = JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"));
	assert.deepEqual(after.packages, ["/app"]);
	assert.equal(after.theme, "dark");
	assert.equal(mt.disabledReason(pkg), "сломалось");
	mt.setMyTools(pkg, true, "", env);
	assert.equal(mt.disabledReason(pkg), undefined);
});

// --- запись функции с откатом --------------------------------------------------------------------------------

const OK_CODE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default function (pi: ExtensionAPI) { pi.registerTool({ name: "t", label: "t", description: "d", parameters: {}, async execute() { return { content: [], details: {} }; } } as any); }\n`;

test("my_tools_save: хорошая функция остаётся, плохая откатывается (новая — удаляется, старая — возвращается)", async () => {
	const w = ws();
	const pkg = mt.myToolsDir(w);
	const good = async () => ({ ok: true, output: "", code: 0 });
	const bad = async () => ({ ok: false, output: 'Error: Failed to load extension "x.ts": boom', code: 1 });
	let r = await mt.saveTool(pkg, "track_minutes", OK_CODE, good);
	assert.equal(r.ok, true);
	assert.ok(existsSync(path.join(pkg, "package.json")), "пакет создан");
	const file = path.join(pkg, "extensions", "track_minutes.ts");
	assert.equal(readFileSync(file, "utf8"), OK_CODE);
	r = await mt.saveTool(pkg, "track_minutes", OK_CODE.replace('"t"', '"t2"') + "// v2\n", bad);
	assert.equal(r.ok, false);
	assert.equal(r.rolledBack, true);
	assert.equal(readFileSync(file, "utf8"), OK_CODE, "вернулась прежняя версия");
	assert.ok(!existsSync(file + ".bak"));
	r = await mt.saveTool(pkg, "broken_one", "export default function (pi { // " + "x".repeat(40), bad);
	assert.equal(r.ok, false);
	assert.ok(!existsSync(path.join(pkg, "extensions", "broken_one.ts")), "новый битый файл удалён");
	assert.match(r.message, /Failed to load extension/);
	assert.equal((await mt.saveTool(pkg, "Bad-Name", OK_CODE, good)).ok, false);
	assert.equal((await mt.saveTool(pkg, "no_default", "const a = 1; ".repeat(10), good)).ok, false);
	assert.deepEqual(mt.listTools(pkg), ["track_minutes.ts"]);
});

test("my_tools_save при выключенном пакете проверяет файл явно (-e), потому что в settings его нет", async () => {
	const w = ws();
	const pkg = mt.myToolsDir(w);
	mt.ensurePackage(pkg);
	writeFileSync(path.join(path.dirname(pkg), "my_tools_disabled"), "сломалось\n");
	let seen: string[] = [];
	await mt.saveTool(pkg, "one_tool", OK_CODE, async (extra) => {
		seen = extra;
		return { ok: true, output: "", code: 0 };
	});
	assert.deepEqual(seen, [path.join(pkg, "extensions", "one_tool.ts")]);
});

// --- probePi на подменённом pi ---------------------------------------------------------------------------------

function fakePi(mode: "ok" | "load_error" | "late_crash" | "silent"): string {
	const dir = tmp("mm-fakepi-");
	const file = path.join(dir, "pi.mjs");
	writeFileSync(
		file,
		`#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
if (mode === "load_error") { console.error('Error: Failed to load extension "/x/bad.ts": boom'); process.exit(1); }
if (mode === "silent") { setTimeout(() => {}, 60000); } else {
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  if (d.includes("get_commands")) {
    console.log(JSON.stringify({ type: "response", command: "get_commands", success: true, data: { commands: [] } }));
    if (mode === "late_crash") setTimeout(() => { console.error("error: late"); process.exit(1); }, 300);
  }
});
process.stdin.on("end", () => process.exit(0));
}
`,
	);
	chmodSync(file, 0o755);
	return file;
}

test("probePi: загрузилось — ok; ошибка загрузки, падение из таймера и молчание — не ok", async () => {
	const run = (mode: any, extra: object = {}) => mt.probePi({ cmd: { file: fakePi(mode), args: [], shell: false }, lateMs: 800, timeoutMs: 4000, ...extra });
	assert.equal((await run("ok")).ok, true);
	const le = await run("load_error");
	assert.equal(le.ok, false);
	assert.match(le.output, /Failed to load extension/);
	assert.equal((await run("late_crash")).ok, false, "упало после ответа — всё равно не ok");
	const silent = await run("silent", { timeoutMs: 1200 });
	assert.equal(silent.ok, false);
	assert.equal(silent.timedOut, true);
});

test("piCommand: MM_PI важнее, node/bun берут скрипт, собранный pi — сам себя", () => {
	assert.deepEqual(mt.piCommand({ MM_PI: "C:\\x\\pi.cmd" } as any), { file: "C:\\x\\pi.cmd", args: [], shell: true });
	assert.deepEqual(mt.piCommand({}, "/usr/bin/node", "/lib/pi/cli.js"), { file: "/usr/bin/node", args: ["/lib/pi/cli.js"], shell: false });
	assert.deepEqual(mt.piCommand({}, "/home/u/pi", "/$bunfs/root/pi"), { file: "/home/u/pi", args: [], shell: false });
});

// --- аварийный выключатель (guard) ------------------------------------------------------------------------------

function guardEnv() {
	const w = ws();
	const pkg = mt.myToolsDir(w);
	const agent = tmp("mm-agent-");
	const root = tmp("mm-root-");
	const env = { PI_CODING_AGENT_DIR: agent, MM_ROOT: root } as NodeJS.ProcessEnv;
	writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["/app", pkg] }));
	return { w, pkg, agent, root, env };
}

test("guard: pi упал на старте из-за my_tools — пакет выключен, строка показана, код «перезапусти»", async () => {
	const g = guardEnv();
	const lines: string[] = [];
	const code = await guardMod.guard(1, 1000, { env: g.env, now: () => 3000, probe: async () => ({ ok: false, output: 'Error: Failed to load extension "bad.ts": boom' }), say: (l) => lines.push(l) });
	assert.equal(code, guardMod.EXIT_RETRY);
	assert.deepEqual(lines, ["Мои функции выключены — что-то в них сломалось, скажи агенту «почини мои функции»."]);
	assert.deepEqual(JSON.parse(readFileSync(path.join(g.agent, "settings.json"), "utf8")).packages, ["/app"]);
	assert.match(mt.disabledReason(g.pkg) ?? "", /Failed to load extension/);
	assert.match(readFileSync(path.join(g.root, "logs", "my_tools_guard.log"), "utf8"), /boom/);
});

test("guard: не трогает, если pi упал не из-за функций, поздно, с кодом 0 или пакета нет", async () => {
	const g = guardEnv();
	const never = async () => {
		throw new Error("проверку не должны были запускать");
	};
	assert.equal(await guardMod.guard(0, 1000, { env: g.env, now: () => 2000, probe: never }), 0);
	assert.equal(await guardMod.guard(1, 1000, { env: g.env, now: () => 1000 + guardMod.GUARD_WINDOW_MS + 1, probe: never }), 0, "упал не на старте");
	assert.equal(await guardMod.guard(NaN, 1000, { env: g.env, now: () => 2000, probe: never }), 0);
	assert.equal(await guardMod.guard(1, NaN, { env: g.env, now: () => 2000, probe: never }), 0);
	assert.equal(await guardMod.guard(1, 1000, { env: g.env, now: () => 2000, probe: async () => ({ ok: true, output: "" }), say: () => never() }), 0, "pi с функциями грузится — виноват не он");
	assert.ok(ps.findMyToolsPackage(JSON.parse(readFileSync(path.join(g.agent, "settings.json"), "utf8"))), "пакет на месте");
	const none = guardEnv();
	writeFileSync(path.join(none.agent, "settings.json"), JSON.stringify({ packages: ["/app"] }));
	assert.equal(await guardMod.guard(1, 1000, { env: none.env, now: () => 2000, probe: never }), 0, "пакета в settings нет");
});

test("guard.ts запускается как скрипт node: код 0 при отсутствии settings", () => {
	const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "lib", "mm", "guard.ts"), "1", String(Date.now())], { env: { ...process.env, PI_CODING_AGENT_DIR: tmp("mm-agent-") }, encoding: "utf8", timeout: 30_000 });
	assert.equal(r.status, 0, r.stderr);
});


// --- согласие и заявки ----------------------------------------------------------------------------------------------

test("«да» ученика: короткое согласие принимается, правка, отказ и длинный ответ — нет", () => {
	for (const t of ["да", "Да!", "да, отправляй", "ага", "ок", "отправляй", "yes", "давай"]) assert.equal(wish.isYes(t), true, t);
	for (const t of ["нет", "не надо", "да нет, не сейчас", "подожди", "а что там написано?", "да, но добавь про клавиши и ещё про то, чтобы он умел всё подряд", "", "дальше"]) assert.equal(wish.isYes(t), false, t);
});

test("замок согласия: без черновика, без ответа, после чужой реплики и после «нет» не отправляет", () => {
	const g = new wish.ConsentGate();
	g.onUserInput("хочу, чтобы ты умел делать мастеринг");
	assert.equal(g.approve().ok, false);
	g.setDraft("Хочу мастеринг");
	assert.match((g.approve() as any).reason, /ещё не ответил/);
	g.onUserInput("нет, подожди");
	assert.match((g.approve() as any).reason, /не согласился/);
	g.setDraft("Хочу мастеринг");
	g.onUserInput("а что насчёт баса?");
	g.onUserInput("да");
	assert.match((g.approve() as any).reason, /писал о другом/);
	g.setDraft("Хочу мастеринг");
	g.onUserInput("да");
	const a = g.approve();
	assert.equal(a.ok, true);
	assert.equal((a as any).text, "Хочу мастеринг");
});

function fakeFetch(plan: Array<{ status?: number; throw?: string }>, calls: any[] = []): typeof fetch {
	return (async (url: any, init: any) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		const p = plan.shift() ?? { status: 200 };
		if (p.throw) throw new Error(p.throw);
		return { ok: (p.status ?? 200) < 300, status: p.status ?? 200 } as Response;
	}) as any;
}

test("заявка: отправлена — в журнале «отправлена»; нет сети — «ждёт отправки»; повтор раз в сутки", async () => {
	const w = ws();
	const root = tmp("mm-root-");
	const calls: any[] = [];
	const ok = await wish.submitWish(w, "Хочу, чтобы агент умел делать мастеринг", { fetch: fakeFetch([{ status: 200 }], calls), url: "http://x/api/wish", version: "0.1.5" });
	assert.equal(ok.sent, true);
	assert.equal(calls[0].init.headers["x-mm-token"], wish.proto.token);
	assert.deepEqual(Object.keys(calls[0].body).sort(), ["id", "text", "v"], "в запросе только id, текст и версия — ничего личного");
	const off = await wish.submitWish(w, "Хочу ещё и разбор вокала по wav", { fetch: fakeFetch([{ throw: "нет сети" }]) });
	assert.equal(off.sent, false);
	assert.deepEqual(wish.readWishes(w).map((e) => e.status), [wish.SENT, wish.PENDING]);
	// сутки не прошли с последней попытки? — попыток не было, пробуем
	const day = new Date("2026-11-27T10:00:00Z");
	const c2: any[] = [];
	assert.deepEqual(await wish.retryPending(w, { fetch: fakeFetch([{ throw: "нет сети" }], c2), root, now: day }), { tried: 1, sent: 0 });
	assert.deepEqual(await wish.retryPending(w, { fetch: fakeFetch([{ status: 200 }], c2), root, now: new Date(day.getTime() + 3_600_000) }), { tried: 0, sent: 0 }, "раз в сутки");
	assert.equal(c2.length, 1);
	const r3 = await wish.retryPending(w, { fetch: fakeFetch([{ status: 200 }], c2), root, now: new Date(day.getTime() + 25 * 3_600_000) });
	assert.deepEqual(r3, { tried: 1, sent: 1 });
	assert.deepEqual(wish.readWishes(w).map((e) => e.status), [wish.SENT, wish.SENT]);
	assert.deepEqual(await wish.retryPending(w, { fetch: fakeFetch([], c2), root, now: new Date(day.getTime() + 60 * 3_600_000) }), { tried: 0, sent: 0 }, "ждущих нет");
});

test("замок согласия переживает перезапуск процесса и /reload, но черновик живёт полчаса", () => {
	const dir = tmp("mm-gate-");
	let t = 1_000_000;
	const mk = () => new wish.ConsentGate(wish.fileGateStore("/work/Music", dir), () => t);
	const g1 = mk();
	g1.onUserInput("хочу мастеринг");
	g1.setDraft("Заявка про мастеринг треков");
	const g2 = mk(); // другой процесс pi (например -p на втором ходу)
	assert.match((g2.approve() as any).reason, /ещё не ответил/);
	g2.onUserInput("да");
	assert.equal(mk().approve().ok, true, "«да» в новом процессе засчитано");
	t += wish.DRAFT_TTL_MS + 1;
	assert.match((mk().approve() as any).reason, /устарел/);
	assert.notEqual(wish.fileGateStore("/work/Other", dir).load().seq, 3, "у другой рабочей папки свой замок");
});

// --- инструменты как их видит pi ---------------------------------------------------------------------------------

function harness(ext: any, deps: object) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	ext.default({ registerTool: (t: any) => tools.set(t.name, t), on: (n: string, h: Function) => handlers.set(n, [...(handlers.get(n) ?? []), h]) } as any, deps);
	const call = (name: string, params: object, cwd: string) => tools.get(name).execute("id", params, undefined, undefined, { cwd });
	const emit = (n: string, ...a: any[]) => Promise.all((handlers.get(n) ?? []).map((h) => h(...a)));
	return { tools, call, emit };
}

test("wish_send: без согласия не шлёт ни разу; после «да» шлёт показанный текст; офлайн — в wishes.md", async () => {
	const w = ws();
	const calls: any[] = [];
	const plan: any[] = [{ status: 200 }];
	const stateDir = tmp("mm-gate-");
	const h = harness(wishExt, { fetch: fakeFetch(plan, calls), root: tmp("mm-root-"), version: "0.1.5", stateDir });
	const ctxOf = { cwd: w };
	await h.emit("input", { text: "хочу, чтобы ты умел делать мастеринг", source: "interactive" }, ctxOf);
	await assert.rejects(h.call("wish_send", { action: "send" }, w), /нет черновика/);
	const d = await h.call("wish_send", { action: "draft", text: "Ученик хочет мастеринг треков. Зачем: сводит дома. Пример: сделать громче без искажений." }, w);
	assert.match(d.content[0].text, /ДОСЛОВНО/);
	await assert.rejects(h.call("wish_send", { action: "send" }, w), /ещё не ответил/);
	assert.equal(calls.length, 0);
	await h.emit("input", { text: "нет, не надо", source: "interactive" }, ctxOf);
	await assert.rejects(h.call("wish_send", { action: "send" }, w), /не согласился/);
	assert.equal(calls.length, 0, "после отказа ничего не ушло");
	await h.call("wish_send", { action: "draft", text: "Ученик хочет мастеринг треков. Зачем: сводит дома. Пример: сделать громче без искажений." }, w);
	await h.emit("input", { text: "да", source: "interactive" }, ctxOf);
	const s = await h.call("wish_send", { action: "send", text: "ПОДМЕНА модели" }, w);
	assert.match(s.content[0].text, /Отправил/);
	assert.equal(calls.length, 1);
	assert.match(calls[0].body.text, /мастеринг треков/);
	assert.doesNotMatch(calls[0].body.text, /ПОДМЕНА/, "уходит дословный черновик, а не то, что передала модель");
	await assert.rejects(h.call("wish_send", { action: "send" }, w), /нет черновика/, "второй раз тем же «да» не отправить");
	// офлайн
	plan.push({ throw: "ENOTFOUND" });
	await h.call("wish_send", { action: "draft", text: "Ещё одна заявка: нужен разбор вокала по экспортированному wav-файлу." }, w);
	await h.emit("input", { text: "ага", source: "interactive" }, ctxOf);
	const o = await h.call("wish_send", { action: "send" }, w);
	assert.match(o.content[0].text, /уйдёт при ближайшем запуске/);
	assert.deepEqual(wish.readWishes(w).map((e) => e.status), [wish.SENT, wish.PENDING]);
	// сообщения от самого расширения согласием не считаются
	await h.call("wish_send", { action: "draft", text: "Третья заявка: хочется метроном с акцентами из агента." }, w);
	await h.emit("input", { text: "да", source: "extension" }, ctxOf);
	await assert.rejects(h.call("wish_send", { action: "send" }, w), /ещё не ответил/);
});

test("wish_send: короткий и длинный текст отклоняются; ничего личного в запросе нет", async () => {
	const w = ws();
	const h = harness(wishExt, { fetch: fakeFetch([]), root: tmp("mm-root-"), stateDir: tmp("mm-gate-") });
	await assert.rejects(h.call("wish_send", { action: "draft", text: "ку" }, w), /короткий/);
	await assert.rejects(h.call("wish_send", { action: "draft", text: "я".repeat(2000) }, w), /длиннее/);
	await assert.rejects(h.call("wish_send", { action: "wat" }, w), /draft, send или cancel/);
});

test("старт сессии: ожидающая заявка уходит сама", async () => {
	const w = ws();
	const root = tmp("mm-root-");
	await wish.submitWish(w, "Заявка, которая не ушла из-за сети: нужен разбор вокала.", { fetch: fakeFetch([{ throw: "нет сети" }]) });
	const calls: any[] = [];
	const h = harness(wishExt, { fetch: fakeFetch([{ status: 200 }], calls), root, stateDir: tmp("mm-gate-") });
	await h.emit("session_start", {}, { cwd: w });
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(calls.length, 1);
	assert.deepEqual(wish.readWishes(w).map((e) => e.status), [wish.SENT]);
});

test("recipe_save / my_tools_save / my_tools_admin: инструменты работают в рабочей папке и сообщают про перезапуск", async () => {
	const w = ws();
	const agent = tmp("mm-agent-");
	const env = { PI_CODING_AGENT_DIR: agent } as NodeJS.ProcessEnv;
	let ok = true;
	const h = harness(growExt, { env, probe: async () => (ok ? { ok: true, output: "", code: 0 } : { ok: false, output: "Failed to load extension x", code: 1 }) });
	const r = await h.call("recipe_save", GOOD, w);
	assert.match(r.content[0].text, /со следующего запуска/);
	await assert.rejects(h.call("recipe_save", GOOD, w), /уже есть/);
	const s = await h.call("my_tools_save", { name: "track_minutes", code: OK_CODE }, w);
	assert.match(s.content[0].text, /после перезапуска/);
	ok = false;
	await assert.rejects(h.call("my_tools_save", { name: "other_one", code: OK_CODE }, w), /откатил/);
	assert.match((await h.call("my_tools_admin", { action: "list" }, w)).content[0].text, /track_minutes\.ts/);
	assert.match((await h.call("my_tools_admin", { action: "check" }, w)).content[0].text, /Не загружается/);
	await h.call("my_tools_admin", { action: "off" }, w);
	assert.match((await h.call("my_tools_admin", { action: "list" }, w)).content[0].text, /выключены/);
	await assert.rejects(h.call("my_tools_admin", { action: "on" }, w), /не включил/);
	assert.ok(mt.disabledReason(mt.myToolsDir(w)), "после неудачного включения остались выключенными");
	ok = true;
	await h.call("my_tools_admin", { action: "on" }, w);
	assert.equal(mt.disabledReason(mt.myToolsDir(w)), undefined);
	assert.ok(ps.findMyToolsPackage(JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"))));
	await h.call("my_tools_admin", { action: "remove", name: "track_minutes" }, w);
	assert.deepEqual(mt.listTools(mt.myToolsDir(w)), []);
	// выключенные функции — заметка в первый ход
	await h.call("my_tools_admin", { action: "off" }, w);
	const note: any[] = [];
	const first = await h.emit("before_agent_start", { messageType: "user" }, { cwd: w, ui: { notify: (m: string) => note.push(m) } });
	assert.match(first[0].message.content, /выключены/);
	assert.match(note[0], /почини мои функции/);
});

// --- приёмник заявок ---------------------------------------------------------------------------------------------------

async function startReceiver(opts: object = {}) {
	const sent: string[] = [];
	const journal = path.join(tmp("mm-journal-"), "wishes.jsonl");
	let tgOk = true;
	const server = receiver.createReceiver({ journal, notify: async (t: string) => (tgOk ? (sent.push(t), true) : false), ...opts });
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as any).port;
	const post = (body: string | object, headers: Record<string, string> = {}, method = "POST") =>
		new Promise<{ status: number; json: any }>((resolve, reject) => {
			const data = typeof body === "string" ? body : JSON.stringify(body);
			const req = http.request({ host: "127.0.0.1", port, path: "/api/wish", method, headers: { "content-type": "application/json", "x-mm-token": wish.proto.token, "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
				let b = "";
				res.on("data", (c) => (b += c));
				res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : null }));
			});
			req.on("error", reject);
			req.end(data);
		});
	return { sent, journal, post, setTg: (v: boolean) => (tgOk = v), close: () => server.close() };
}

const WISH = "Хочу, чтобы агент умел делать мастеринг: сводит дома, надо громче без искажений.";

test("приёмник: принял — Telegram получил с пометкой, журнал написан", async () => {
	const r = await startReceiver();
	try {
		const res = await r.post({ id: "wabc12345", text: WISH, v: "0.1.5" });
		assert.equal(res.status, 200);
		assert.equal(r.sent.length, 1);
		assert.match(r.sent[0], /^music_mentor · заявка\n\n.*мастеринг/s);
		const line = JSON.parse(readFileSync(r.journal, "utf8").trim());
		assert.equal(line.forwarded, true);
		assert.equal(line.text, WISH);
		// повтор того же id не плодит сообщений
		assert.deepEqual((await r.post({ id: "wabc12345", text: WISH })).json, { ok: true, duplicate: true });
		assert.equal(r.sent.length, 1);
	} finally {
		r.close();
	}
});

test("приёмник: токен, размер, мусор, не тот метод и путь", async () => {
	const r = await startReceiver();
	try {
		assert.equal((await r.post({ text: WISH }, { "x-mm-token": "wrong-token" })).status, 403);
		assert.equal((await r.post("не json")).status, 400);
		assert.equal((await r.post("[1,2]")).status, 400);
		assert.equal((await r.post({ text: 42 })).status, 400);
		assert.equal((await r.post({ text: "коротко" })).status, 400);
		assert.equal((await r.post({ text: "а".repeat(200) })).status, 400, "один знак подряд — мусор");
		assert.equal((await r.post({ text: "1234567890 !!!! ???? 12345 ----- 6789" })).status, 400, "почти нет букв");
		assert.equal((await r.post({ text: "я".repeat(5000) })).status, 413, "тело больше 4 КБ");
		assert.equal((await r.post({ text: WISH }, {}, "GET")).status, 405);
		assert.equal(r.sent.length, 0, "ничего мусорного не ушло автору");
		const big = await r.post(JSON.stringify({ text: "слово ".repeat(280) }));
		assert.equal(big.status, 400, "в 4 КБ влезло, но длиннее 1500 знаков");
	} finally {
		r.close();
	}
});

test("приёмник: 5 заявок в сутки с одного адреса, потом 429; другой адрес проходит; сутки спустя — снова можно", async () => {
	let now = Date.parse("2026-11-26T10:00:00Z");
	const r = await startReceiver({ now: () => now });
	try {
		const mk = (i: number) => ({ text: `${WISH} вариант ${"абвгд"[i % 5]}${i}`.replace(/\d/g, "") + ` номер ${"один два три четыре пять шесть".split(" ")[i % 6]}` });
		for (let i = 0; i < 5; i++) assert.equal((await r.post(mk(i), { "cf-connecting-ip": "1.1.1.1" })).status, 200, `заявка ${i + 1}`);
		assert.equal((await r.post(mk(5), { "cf-connecting-ip": "1.1.1.1" })).status, 429);
		assert.equal((await r.post(mk(5), { "cf-connecting-ip": "2.2.2.2" })).status, 200);
		now += 24 * 3600_000 + 1000;
		assert.equal((await r.post(mk(6), { "cf-connecting-ip": "1.1.1.1" })).status, 200);
	} finally {
		r.close();
	}
});

test("приёмник: Telegram недоступен — 502 и запись в журнале; повтор с тем же id уходит и не тратит лимит", async () => {
	const r = await startReceiver({ perIpPerDay: 1 });
	try {
		r.setTg(false);
		const first = await r.post({ id: "wdead0001", text: WISH });
		assert.equal(first.status, 502);
		assert.equal(JSON.parse(readFileSync(r.journal, "utf8").trim().split("\n")[0]).forwarded, false);
		r.setTg(true);
		assert.equal((await r.post({ id: "wdead0001", text: WISH })).status, 200, "тот же id: лимит повторно не тратится");
		assert.equal(r.sent.length, 1);
	} finally {
		r.close();
	}
});

test("приёмник: общий суточный потолок", async () => {
	const r = await startReceiver({ globalPerDay: 2, perIpPerDay: 10 });
	try {
		assert.equal((await r.post({ text: WISH + " раз" }, { "cf-connecting-ip": "1.1.1.1" })).status, 200);
		assert.equal((await r.post({ text: WISH + " два" }, { "cf-connecting-ip": "2.2.2.2" })).status, 200);
		assert.equal((await r.post({ text: WISH + " три" }, { "cf-connecting-ip": "3.3.3.3" })).status, 429);
	} finally {
		r.close();
	}
});

// --- пакет, шаблон, документы -----------------------------------------------------------------------------------------

const ROOT = path.join(import.meta.dirname, "..");

test("шаблон рабочей папки: recipes/, my_tools/ с пакетом pi, всё под learner/ — обновление не трогает", () => {
	const t = path.join(ROOT, "template", "learner");
	assert.ok(existsSync(path.join(t, "recipes")));
	const pj = JSON.parse(readFileSync(path.join(t, "my_tools", "package.json"), "utf8"));
	assert.deepEqual(pj.pi.extensions, ["./extensions"]);
	assert.ok(existsSync(path.join(t, "my_tools", "extensions")));
});

test("скилл: раздел «Расти», первая строка про «Макса», заявка только с «да»", () => {
	const s = readFileSync(path.join(ROOT, "skills", "mentor", "SKILL.md"), "utf8");
	assert.match(s, /## Расти/);
	assert.match(s, /передам заявку Максу/);
	assert.match(s, /Только с его «да»/);
	assert.match(s, /только по просьбе|сам об этом попросил/);
	for (const t of ["recipe_save", "my_tools_save", "my_tools_admin", "wish_send"]) assert.match(s, new RegExp(t));
});

test("открытка и скилл говорят одно: запомнит, допишет по просьбе, заявка Максу", () => {
	const html = readFileSync(path.join(ROOT, "tools", "present", "index.html"), "utf8");
	const part = html.slice(html.indexOf("Если ему чего-то не хватает"), html.indexOf("Если что-то не так"));
	assert.match(part, /запомнит/);
	assert.match(part, /только если ты попросишь/);
	assert.match(part, /заявк/);
	assert.match(part, /«да»/, "в открытке сказано, что заявка уходит после согласия");
});
