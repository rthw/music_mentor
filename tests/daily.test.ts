/**
 * Тихие проверки на старте сессии (раз в сутки), журнал для разговора и общие отметки в данных агента.
 * Сеть не нужна: и версию, и баланс подставляем заглушками.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import "./stubs/packages.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


const upd = await import("../extensions/update.ts");
const log = await import("../extensions/log.ts");
const sess = await import("../lib/mm/session.ts");

const root = () => mkdtempSync(path.join(tmpdir(), "mm-root-"));

test("отметка «раз в сутки»: нет файла — пора, записали — не пора, сутки прошли — пора", () => {
	const file = sess.stampPath(root(), "check");
	assert.equal(sess.stampPath("/x", "check").endsWith(path.join("/x", "check.txt")), true);
	const now = new Date("2026-11-26T10:00:00Z");
	assert.equal(sess.shouldRunDaily(file, now), true);
	sess.markRun(file, now);
	assert.equal(sess.shouldRunDaily(file, new Date("2026-11-26T23:59:00Z")), false);
	assert.equal(sess.shouldRunDaily(file, new Date("2026-11-27T10:00:01Z")), true);
	writeFileSync(file, "мусор\n");
	assert.equal(sess.shouldRunDaily(file, now), true, "битая дата = как будто не делали");
});

test("корень данных агента: MM_ROOT важнее LOCALAPPDATA", () => {
	assert.equal(sess.mmRoot({ MM_ROOT: "/tmp/mm" } as any), "/tmp/mm");
	assert.equal(sess.mmRoot({ LOCALAPPDATA: "/tmp/local" } as any), path.join("/tmp/local", "music_mentor"));
});

test("баланс: предупреждение только ниже порога (1 USD / 7 CNY)", () => {
	assert.equal(upd.balanceWarning({ balance_infos: [{ currency: "CNY", total_balance: "120.50" }] }), undefined);
	assert.match(upd.balanceWarning({ balance_infos: [{ currency: "CNY", total_balance: "3.10" }] }) ?? "", /3\.10 CNY/);
	assert.match(upd.balanceWarning({ balance_infos: [{ currency: "USD", total_balance: "0.40" }] }) ?? "", /скоро закончится/);
	assert.equal(upd.balanceWarning({ balance_infos: [{ currency: "USD", total_balance: "1.00" }] }), undefined, "ровно порог — не предупреждаем");
	assert.equal(upd.balanceWarning({ balance_infos: [{ currency: "EUR", total_balance: "0" }] }), undefined, "неизвестная валюта — молчим");
	assert.equal(upd.balanceWarning({ balance_infos: [{ currency: "CNY", total_balance: "мусор" }] }), undefined);
	assert.equal(upd.balanceWarning({}), undefined);
	assert.equal(upd.balanceWarning(undefined), undefined);
});

test("обновление на старте: не чаще раза в сутки и повторно не спрашивает сервер", async () => {
	const dir = root();
	let asked = 0;
	const latest = async () => {
		asked++;
		return { current: "v0.1.0", latest: "v0.2.0" };
	};
	const first = await upd.updateReminder({ root: dir, latest });
	assert.match(first ?? "", /новая версия агента v0\.2\.0/);
	const now = new Date();
	assert.equal(await upd.updateReminder({ root: dir, now: new Date(now.getTime() + 3_600_000), latest }), undefined);
	assert.equal(asked, 1, "второй раз в те же сутки сервер не спрашиваем");
	assert.match((await upd.updateReminder({ root: dir, now: new Date(now.getTime() + sess.DAY_MS + 1000), latest })) ?? "", /v0\.2\.0/);
	assert.equal(asked, 2);
});

test("обновление на старте: своя версия и ошибка сети — тишина", async () => {
	assert.equal(await upd.updateReminder({ root: root(), latest: async () => ({ current: "v0.2.0", latest: "v0.2.0" }) }), undefined);
	assert.equal(
		await upd.updateReminder({
			root: root(),
			latest: async () => {
				throw new Error("нет сети");
			},
		}),
		undefined,
	);
	assert.equal(await upd.updateReminder({ root: root(), latest: async () => ({ latest: undefined }) }), undefined);
	// Сеть упала — отметку всё равно ставим: без интернета не переспрашиваем на каждом старте.
	const dir = root();
	let asked = 0;
	const broken = async () => {
		asked++;
		throw new Error("нет сети");
	};
	assert.equal(await upd.updateReminder({ root: dir, latest: broken }), undefined);
	assert.equal(await upd.updateReminder({ root: dir, latest: broken }), undefined);
	assert.equal(asked, 1);
});

test("баланс на старте: низкий баланс — предупреждение, нет ключа или сети — тишина", async () => {
	let asked = 0;
	const dir = root();
	const warned = await upd.balanceReminder({
		root: dir,
		key: () => "ключ",
		balance: async () => {
			asked++;
			return { balance_infos: [{ currency: "CNY", total_balance: "2.00" }] };
		},
	});
	assert.match(warned ?? "", /2\.00 CNY/);
	assert.equal(await upd.balanceReminder({ root: dir, key: () => "ключ", balance: async () => ({ balance_infos: [] }) }), undefined);
	assert.equal(asked, 1, "в те же сутки DeepSeek повторно не спрашиваем");
	assert.equal(await upd.balanceReminder({ root: root(), key: () => undefined }), undefined);
	assert.equal(
		await upd.balanceReminder({
			root: root(),
			key: () => "ключ",
			balance: async () => {
				throw new Error("DeepSeek ответил 500");
			},
		}),
		undefined,
	);
});

test("ключ читается из auth.json pi (type api_key, key)", () => {
	const dir = root();
	writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "ключ-из-файла" } }));
	assert.equal(upd.authFile({ PI_CODING_AGENT_DIR: dir } as any), path.join(dir, "auth.json"));
	assert.equal(upd.readKey(path.join(dir, "auth.json")), "ключ-из-файла");
	writeFileSync(path.join(dir, "auth.json"), "не json");
	assert.equal(upd.readKey(path.join(dir, "auth.json")), undefined);
	assert.equal(upd.readKey(path.join(dir, "нет.json")), undefined);
});

test("mentor_log: самый свежий журнал и хвост строк", () => {
	const dir = root();
	const logs = log.logsDir(dir);
	assert.equal(logs, path.join(dir, "logs"));
	assert.equal(log.latestLog(logs), undefined, "каталога нет — не падаем");
	mkdirSync(logs, { recursive: true });
	writeFileSync(path.join(logs, "install_2026-11-26_101010.log"), "старый\n");
	writeFileSync(path.join(logs, "update_2026-11-26_111111.log"), Array.from({ length: 150 }, (_, i) => `строка ${i + 1}`).join("\n") + "\n");
	writeFileSync(path.join(logs, "не_журнал.txt"), "x\n");
	assert.equal(log.latestLog(logs), path.join(logs, "update_2026-11-26_111111.log"));
	const lines = log.tail("a\nb\nc\n\n");
	assert.deepEqual(lines, ["a", "b", "c"]);
	const hundred = log.tail(Array.from({ length: 150 }, (_, i) => `строка ${i + 1}`).join("\n"));
	assert.equal(hundred.length, 100);
	assert.equal(hundred[0], "строка 51");
});

test("mentor_log: зарегистрирован как тул и показывает файл и хвост", async () => {
	const tools: any[] = [];
	log.default({ registerTool: (t: any) => tools.push(t) } as any);
	assert.deepEqual(tools.map((t) => t.name), ["mentor_log"]);
	const dir = root();
	mkdirSync(path.join(dir, "logs"), { recursive: true });
	const file = path.join(dir, "logs", "install_2026-11-26_101010.log");
	writeFileSync(file, "=== music_mentor: install ===\nШаг 1 (Git) не получился\n");
	const prev = process.env.MM_ROOT;
	process.env.MM_ROOT = dir;
	try {
		const out = await tools[0].execute("id", {});
		assert.match(out.content[0].text, /Журнал: /);
		assert.match(out.content[0].text, /Шаг 1 \(Git\) не получился/);
		assert.equal(out.details.file, file);
	} finally {
		if (prev === undefined) delete process.env.MM_ROOT;
		else process.env.MM_ROOT = prev;
	}
});

test("mentor_log: журналов нет — говорит куда смотреть, не выдумывает", async () => {
	const tools: any[] = [];
	log.default({ registerTool: (t: any) => tools.push(t) } as any);
	const prev = process.env.MM_ROOT;
	process.env.MM_ROOT = root();
	try {
		const out = await tools[0].execute("id", {});
		assert.match(out.content[0].text, /Журналов пока нет/);
	} finally {
		if (prev === undefined) delete process.env.MM_ROOT;
		else process.env.MM_ROOT = prev;
	}
});
