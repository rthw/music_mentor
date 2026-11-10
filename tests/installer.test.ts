import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const PS_FILES = ["install.ps1", "change_key.ps1", "update.ps1", "lib/win/common.ps1"];

function findPwsh(): string | undefined {
	const cands = [process.env.MM_PWSH, "pwsh"].filter(Boolean) as string[];
	for (const c of cands) {
		const r = spawnSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", timeout: 60_000 });
		if (r.status === 0) return c;
	}
	const m = spawnSync("mise", ["which", "pwsh"], { encoding: "utf8", timeout: 30_000 });
	if (m.status === 0 && m.stdout.trim()) return m.stdout.trim();
	return undefined;
}
const pwsh = findPwsh();
const skipPs = pwsh ? false : "pwsh не найден (mise use pwsh или MM_PWSH)";

test("PowerShell-файлы: UTF-8 с BOM, кроме install.ps1 (его читает irm | iex, BOM ломает первую команду)", () => {
	for (const f of PS_FILES) {
		const b = readFileSync(path.join(ROOT, f));
		const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
		assert.equal(bom, f !== "install.ps1", f === "install.ps1" ? "install.ps1 не должен начинаться с BOM" : `${f} без BOM`);
	}
});

test("PowerShell-файлы: нет голого exit и Stop-Process", () => {
	for (const f of PS_FILES) {
		const lines = readFileSync(path.join(ROOT, f), "utf8").split("\n");
		lines.forEach((line, i) => {
			const code = line.replace(/#.*$/, "").replace(/'[^']*'|"[^"]*"/g, '""');
			assert.ok(!/(^|[\s;{(])exit(\s|;|$)/i.test(code), `${f}:${i + 1}: голый exit: ${line.trim()}`);
			assert.ok(!/\[Environment\]::Exit|Stop-Process|taskkill/i.test(code), `${f}:${i + 1}: принудительный выход: ${line.trim()}`);
		});
	}
});

test("install.ps1: каждый шаг идёт через Invoke-Step, тег и ключ не зашиты", () => {
	const s = readFileSync(path.join(ROOT, "install.ps1"), "utf8");
	for (let n = 1; n <= 10; n++) assert.match(s, new RegExp(`Invoke-Step ${n} `), `нет шага ${n}`);
	assert.match(s, /\$MmTag = if \(\$env:MM_TAG\) \{ \$env:MM_TAG \} else \{ 'v\d+\.\d+\.\d+[^']*' \}/);
	assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(s));
});

test("PowerShell: разбор Library.cfg, выбор пути моста, идемпотентность, обновление, ошибка шага", { skip: skipPs, timeout: 300_000 }, () => {
	const r = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-File", path.join(import.meta.dirname, "installer", "installer.tests.ps1")], { cwd: ROOT, encoding: "utf8", timeout: 280_000 });
	const out = (r.stdout ?? "") + (r.stderr ?? "");
	assert.equal(r.status, 0, out);
	assert.match(out, /ALL OK (\d+)/, out);
	assert.ok(Number(/ALL OK (\d+)/.exec(out)![1]) >= 40, out);
});

/** Фейковый DeepSeek: /user/balance по таблице ключей. Сам ключ в ответах не повторяется. */
function fakeDeepseek(): Promise<{ url: string; close: () => void; seenAuth: string[] }> {
	const seenAuth: string[] = [];
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const auth = req.headers.authorization ?? "";
			seenAuth.push(auth);
			if (req.url !== "/user/balance") return void res.writeHead(404).end();
			if (auth === "Bearer good-key-12345") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.50" }] }));
			else if (auth === "Bearer empty-key-12345") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }));
			else res.writeHead(401).end("{}");
		});
		server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close(), seenAuth }));
	});
}

function runPs(code: string, env: Record<string, string>): Promise<{ status: number | null; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(pwsh!, ["-NoProfile", "-NonInteractive", "-Command", code], { cwd: ROOT, env: { ...process.env, ...env } });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("close", (status) => resolve({ status, out }));
	});
}

test("PowerShell: проверка ключа по балансу и change_key на фейковом DeepSeek", { skip: skipPs, timeout: 120_000 }, async () => {
	const srv = await fakeDeepseek();
	try {
		const tmp = mkdtempSync(path.join(tmpdir(), "mm_key_"));
		const env = { MM_DEEPSEEK_API: srv.url, MM_NO_RUN: "1", MM_HOME: tmp, PI_CODING_AGENT_DIR: path.join(tmp, "agent") };
		const code = `. ./lib/win/common.ps1; foreach ($k in 'good-key-12345','empty-key-12345','bad-key-123456') { $r = Test-DeepSeekKey $k; "$($r.Ok)|$($r.Text)" }`;
		const r = await runPs(code, env);
		assert.equal(r.status, 0, r.out);
		const lines = r.out.trim().split("\n");
		assert.match(lines[0], /^True\|ключ принят, баланс: 42\.50 CNY$/);
		assert.match(lines[1], /^True\|.*денег на балансе нет/);
		assert.match(lines[2], /^False\|DeepSeek не принял ключ \(401\)/);
		for (const k of ["good-key-12345", "empty-key-12345", "bad-key-123456"]) assert.ok(!r.out.includes(k), "ключ попал в вывод");
		assert.ok(srv.seenAuth.includes("Bearer good-key-12345"));
		// сеть недоступна -> исключение с понятным текстом, не молчание
		const down = await runPs(`. ./lib/win/common.ps1; try { Test-DeepSeekKey 'good-key-12345' } catch { "ERR|" + $_.Exception.Message }`, { ...env, MM_DEEPSEEK_API: "http://127.0.0.1:1" });
		assert.match(down.out, /ERR\|не удалось связаться с api\.deepseek\.com/);
		assert.ok(!down.out.includes("good-key-12345"));
	} finally {
		srv.close();
	}
});

test("tools/invite.sh: без секрета — подсказка, со значением — строка идёт только в wl-copy", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mm_invite_"));
	const clip = path.join(dir, "clip.txt");
	writeFileSync(path.join(dir, "wl-copy"), `#!/bin/sh\ncat > "${clip}"\n`);
	chmodSync(path.join(dir, "wl-copy"), 0o755);
	writeFileSync(path.join(dir, "secret"), `#!/bin/sh\nif [ "$1" = list ]; then [ -n "$FAKE_HAS" ] && echo deepseek_music_mentor; exit 0; fi\nif [ "$1" = run ]; then shift 3; deepseek_music_mentor="$FAKE_VAL" exec "$@"; fi\n`);
	chmodSync(path.join(dir, "secret"), 0o755);
	const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
	const none = spawnSync("bash", ["tools/invite.sh"], { cwd: ROOT, env: { ...env, FAKE_HAS: "" }, encoding: "utf8" });
	assert.notEqual(none.status, 0);
	assert.match(none.stderr, /secret set deepseek_music_mentor/);
	const val = "fakeval" + "-9876543210";
	const ok = spawnSync("bash", ["tools/invite.sh"], { cwd: ROOT, env: { ...env, FAKE_HAS: "1", FAKE_VAL: val }, encoding: "utf8" });
	assert.equal(ok.status, 0, ok.stderr);
	assert.ok(!ok.stdout.includes(val) && !ok.stderr.includes(val), "ключ попал в терминал");
	const line = readFileSync(clip, "utf8");
	assert.match(line, /^\$env:MM_KEY='fakeval-9876543210'; irm https:\/\/raw\.githubusercontent\.com\/rthw\/music_mentor\/v\d+\.\d+\.\d+[^/]*\/install\.ps1 \| iex$/);
	assert.match(ok.stdout, /скопирована в буфер/);
});

try {
	await import("typebox");
} catch {
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier === "typebox") return { url: new URL("./stubs/typebox.ts", import.meta.url).href, shortCircuit: true };
			return next(specifier, context);
		},
	});
}
const upd = await import("../extensions/update.ts");

test("mentor_update: последний стабильный тег (числовое сравнение, rc игнорируются)", () => {
	assert.equal(upd.latestStableTag(["v0.2.0", "v0.10.0", "v0.9.9", "v1.0.0-rc.1", "junk"]), "v0.10.0");
	assert.equal(upd.latestStableTag(["v0.1.0-rc.1"]), undefined);
	assert.equal(upd.latestStableTag([]), undefined);
});

test("mentor_update: зарегистрирован как тул", () => {
	const tools: any[] = [];
	upd.default({ registerTool: (t: any) => tools.push(t) } as any);
	assert.deepEqual(tools.map((t) => t.name), ["mentor_update"]);
});

test("в репо нет ключей и путей автора", () => {
	const walk = (d: string): string[] =>
		readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
	for (const f of walk(ROOT)) {
		if (/\.(als|pyc)$/.test(f)) continue;
		const t = readFileSync(f, "utf8");
		assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(t), `${f}: похоже на ключ`);
		assert.ok(!t.includes("/home/" + "max"), `${f}: путь автора`);
	}
});

test("запуск .ps1 с диска всегда с -ExecutionPolicy Bypass (на чистой Win11 политика Restricted)", () => {
	for (const f of ["lib/win/common.ps1", "extensions/update.ts"]) {
		const s = readFileSync(path.join(ROOT, f), "utf8");
		const calls = s.split("\n").filter((l) => /["']-File["' ]/.test(l) && !/Get-ChildItem/.test(l));
		assert.ok(calls.length > 0, `${f}: нет вызовов -File`);
		for (const l of calls) assert.match(l, /Bypass/, `${f}: -File без Bypass: ${l.trim()}`);
	}
	const sc = readFileSync(path.join(ROOT, "lib/win/common.ps1"), "utf8");
	assert.equal((sc.match(/-NoProfile -ExecutionPolicy Bypass -File/g) ?? []).length, 2, "оба ярлыка с .ps1 запускаются с Bypass");
});
