/**
 * T1938/T1940: установка для Win7 (мост по HTTPS + веб-терминал в браузере) и заведение ученика на сервере.
 * Статические проверки шаблонов — всегда; тест new_learner.sh против временного контейнера — если есть docker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const VPS = path.join(ROOT, "tools", "vps");
const WIN7 = path.join(VPS, "win7");
const read = (p: string) => readFileSync(p, "utf8");

test("win7: .cmd-файлы и PowerShell-скрипт только ASCII (cmd Win7 живёт в cp866)", () => {
	for (const f of ["install_win7.cmd", "win7_shortcut.ps1"]) {
		const t = readFileSync(path.join(WIN7, f));
		for (let i = 0; i < t.length; i++) assert.ok(t[i] < 128, `${f}: не-ASCII байт на позиции ${i}`);
	}
});

test("win7: PuTTY и ssh-туннель из поставки убраны (TCP наружу не выпустить)", () => {
	assert.ok(!existsSync(path.join(WIN7, "start_mentor.cmd.tmpl")));
	const t = read(path.join(WIN7, "install_win7.cmd")) + read(path.join(WIN7, "README.txt.tmpl")) + read(path.join(VPS, "new_learner.sh"));
	assert.ok(!/putty|\.ppk|puttygen|-hostkey/i.test(t.replace(/PuTTY и ssh-туннель/g, "")), "следов PuTTY нет");
});

test("win7: установщик — копирование, мост в User Library, UCRT только если нет, ярлык, подсказка про Live", () => {
	const t = read(path.join(WIN7, "install_win7.cmd"));
	assert.match(t, /%LOCALAPPDATA%\\music_mentor/);
	assert.match(t, /Ableton\\User Library\\Remote Scripts/);
	assert.match(t, /if not exist "%RS%" mkdir/, "папки User Library создаются");
	assert.match(t, /rmdir \/s \/q "%RS%\\MentorBridge"/, "повторный запуск заменяет мост");
	assert.match(t, /if exist "%SystemRoot%\\System32\\ucrtbase\.dll" goto ucrt_ok/);
	assert.match(t, /vc_redist\.x64\.exe[^\n]*'\/install','\/quiet','\/norestart'/);
	assert.match(t, /Link MIDI - Control Surface/);
	assert.match(t, /copy \/y "%SRC%mentor_remote\.json" "%RS%\\MentorBridge\\"/, "мост получает адрес и токен");
	assert.match(t, /mentor_url\.txt/);
	assert.ok(!/irm|iex|Invoke-Expression|DownloadFile|Invoke-WebRequest/i.test(t), "ничего из сети");
	// каждый goto ведёт на существующую метку
	const labels = new Set([...t.matchAll(/^:(\w+)/gm)].map((m) => m[1].toLowerCase()));
	for (const g of t.matchAll(/goto (\w+)/gi)) assert.ok(g[1].toLowerCase() === "eof" || labels.has(g[1].toLowerCase()), `goto ${g[1]} без метки`);
	// PowerShell 2.0: ярлык строится без возможностей новее
	const ps = read(path.join(WIN7, "win7_shortcut.ps1"));
	assert.match(ps, /\[InternetShortcut\]/, "ярлык — ссылка на веб-терминал");
	assert.match(ps, /\^https:\/\//);
	assert.ok(!/Set-Clipboard|ConvertFrom-Json|Invoke-RestMethod|\?\./.test(ps), "PS 2.0");
	const codes = ps.match(/\$codes = ([\d,]+)/)![1].split(",").map(Number);
	assert.equal(String.fromCharCode(...codes), "Музыкальный наставник");
});

test("sshd_mm.conf (администрирование): ученики по группе; только ключ; контейнер и скрипты HTTPS-режима", () => {
	const t = read(path.join(VPS, "sshd_mm.conf"));
	assert.match(t, /^AllowGroups mentors$/m);
	assert.match(t, /^Match Group mentors$/m);
	assert.ok(!/AllowUsers|Match User/.test(t));
	assert.match(t, /^PasswordAuthentication no$/m);
	assert.match(t, /^AllowTcpForwarding remote$/m);
	const d = read(path.join(VPS, "Dockerfile"));
	assert.match(d, /groupadd mentors/);
	assert.ok(!/useradd[^\n]*drug/.test(d), "ученика в образе больше нет");
	const l = read(path.join(VPS, "mentor_login.sh"));
	assert.match(l, /MM_LIVE_PORT/);
	assert.match(d, /ttyd/);
	assert.match(d, /EXPOSE 22 8794/);
	const run = read(path.join(VPS, "run_container.sh"));
	assert.match(run, /-p "127\.0\.0\.1:\$port:8794"/, "порт только на loopback");
	assert.match(run, /--restart unless-stopped/);
	assert.match(run, /\$\{name\}_home:\/home/);
	assert.match(run, /\$\{name\}_ssh:\/etc\/ssh/);
	const w = read(path.join(VPS, "mentor_web.sh"));
	assert.match(w, /grep -qx mentors/, "терминал открывает только учеников");
});

test("mm_provision: настройки pi как Set-PiSettings (deepseek, модели, quietStartup, рецепты, свои функции)", async () => {
	const { mergeSettings } = await import(path.join(VPS, "mm_provision.mjs"));
	const ws = "/home/ivan/music_mentor";
	const s = mergeSettings({ packages: ["../x/pkg", "/old/learner/my_tools"], skills: ["/other", "/old/learner/recipes"], foo: 1 }, { workspace: ws });
	assert.equal(s.defaultProvider, "deepseek");
	assert.equal(s.defaultModel, "deepseek-v4-pro");
	assert.equal(s.quietStartup, true);
	assert.equal(s.hideThinkingBlock, true);
	assert.deepEqual(s.enabledModels, ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"]);
	assert.deepEqual(s.skills, ["/other", `${ws}/learner/recipes`]);
	assert.deepEqual(s.packages, ["../x/pkg", `${ws}/learner/my_tools`]);
	assert.equal(s.foo, 1);
	// идемпотентность
	assert.deepEqual(mergeSettings(structuredClone(s), { workspace: ws }), s);
});

test("README для друга: по-русски, 3–5 шагов, без ключа DeepSeek", () => {
	const t = read(path.join(WIN7, "README.txt.tmpl"));
	const steps = t.match(/^\d\. /gm) ?? [];
	assert.ok(steps.length >= 3 && steps.length <= 5, `шагов: ${steps.length}`);
	assert.match(t, /[А-Яа-я]/);
	assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(t));
	assert.match(t, /Chrome 109/);
	assert.match(t, /Firefox 115/);
	assert.match(t, /Control Surface/);
});

// --- new_learner.sh против временного контейнера + сквозной тест моста по HTTP --------------------------

function sh(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
	return spawnSync(cmd, args, { encoding: "utf8", input: opts.input, env: { ...process.env, ...opts.env }, timeout: opts.timeout ?? 600_000 });
}
const hasDocker = sh("docker", ["info"], { timeout: 30_000 }).status === 0;
const skipDocker = hasDocker ? false : "docker недоступен";
const hasUnzip = sh("unzip", ["-v"]).status === 0;
const skipUnzip = skipDocker || (hasUnzip ? false : "нет unzip");

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

test("new_learner.sh + контейнер: zip с нужным составом, токен только хешем, мост (fake_lom) по HTTP → live ping через порт ученика", { skip: skipUnzip, timeout: 900_000 }, async () => {
	const tag = `mm_vps_test_${process.pid}`;
	const tmp = mkdtempSync(path.join(tmpdir(), "mm_nl_"));
	const assets = path.join(tmp, "assets");
	mkdirSync(assets);
	writeFileSync(path.join(assets, "vc_redist.x64.exe"), "MZ-fake-vc");
	const fakeKey = "sk" + "-testtesttesttest1234567890abcd"; // не литералом: тест «в репо нет ключей» ищет такой вид
	const hostPort = await freePort();
	let started = false;
	let bridge: ChildProcess | undefined;
	try {
		const b = sh("docker", ["build", "-q", "-t", tag, VPS]);
		assert.equal(b.status, 0, `docker build: ${b.stderr}`);
		const r = sh("docker", ["run", "-d", "--init", "--name", tag, "-p", `127.0.0.1:${hostPort}:8794`, tag]);
		assert.equal(r.status, 0, r.stderr);
		started = true;
		await new Promise((res) => setTimeout(res, 2000));
		const url = `http://127.0.0.1:${hostPort}/mentor`;
		const env = { MM_CONTAINER: tag, MM_BUNDLES_DIR: path.join(tmp, "bundles"), MM_WIN7_ASSETS: assets, MM_SKIP_ASSET_SHA: "1", MM_DEEPSEEK_KEY: fakeKey, MM_PUBLIC_URL: url };

		// плохие имена и небезопасный адрес отвергаются
		assert.notEqual(sh(path.join(VPS, "new_learner.sh"), ["Bad Name"], { env }).status, 0);
		assert.notEqual(sh(path.join(VPS, "new_learner.sh"), ["bad", "--url", "http://example.com/mentor"], { env }).status, 0, "токен только по https");

		const out1 = sh(path.join(VPS, "new_learner.sh"), ["test1"], { env });
		assert.equal(out1.status, 0, out1.stdout + out1.stderr);
		assert.ok(!(out1.stdout + out1.stderr).includes(fakeKey), "ключ DeepSeek в выводе");
		const out2 = sh(path.join(VPS, "new_learner.sh"), ["test2"], { env });
		assert.equal(out2.status, 0, out2.stdout + out2.stderr);
		assert.match(out2.stdout, /порт моста 9902/, "у второго ученика свой порт");

		// состав zip
		const zip = path.join(tmp, "bundles", "test1.zip");
		assert.ok(existsSync(zip));
		const x = path.join(tmp, "x");
		assert.equal(sh("unzip", ["-q", zip, "-d", x]).status, 0);
		const d = path.join(x, "test1");
		for (const f of ["vc_redist.x64.exe", "install_win7.cmd", "README.txt", "win7_shortcut.ps1", "mentor_remote.json", "mentor_url.txt", "MentorBridge/__init__.py", "MentorBridge/server.py", "MentorBridge/remote.py"]) {
			assert.ok(existsSync(path.join(d, f)), `в zip нет ${f}`);
		}
		for (const f of ["putty.exe", "test1.ppk", "Muzykalnyj nastavnik.cmd"]) assert.ok(!existsSync(path.join(d, f)), `в zip не должно быть ${f}`);
		const cfgText = read(path.join(d, "mentor_remote.json"));
		const cfg = JSON.parse(cfgText);
		assert.equal(cfg.url, url);
		assert.ok(cfg.token.length >= 43, "токен ≥ 32 байт в base64url");
		assert.ok(cfgText.includes("\r\n"), "CRLF");
		const link = read(path.join(d, "mentor_url.txt")).trim();
		assert.equal(link, `${url}/t/${cfg.token}/`);
		assert.ok(read(path.join(d, "README.txt")).startsWith("\uFEFF"), "README с BOM для Блокнота");
		assert.ok(!read(path.join(d, "README.txt")).includes(cfg.token), "токена в README нет");
		for (const f of ["install_win7.cmd", "win7_shortcut.ps1"]) assert.ok(!/sk-/.test(read(path.join(d, f))));

		// на сервере: настройки, ключ DeepSeek только у ученика, токен только хешем
		const settings = JSON.parse(sh("docker", ["exec", tag, "cat", "/home/test1/.pi/agent/settings.json"]).stdout);
		assert.equal(settings.defaultModel, "deepseek-v4-pro");
		assert.ok(settings.packages.includes("/home/test1/music_mentor/learner/my_tools"));
		assert.ok(settings.packages.some((p: string) => p.includes("music_mentor_pkg")), "pi install записал пакет");
		const auth = JSON.parse(sh("docker", ["exec", tag, "cat", "/home/test1/.pi/agent/auth.json"]).stdout);
		assert.equal(auth.deepseek.key, fakeKey);
		assert.equal(sh("docker", ["exec", tag, "stat", "-c", "%a", "/home/test1/.pi/agent/auth.json"]).stdout.trim(), "600");
		assert.equal(sh("docker", ["exec", tag, "test", "-f", "/home/test1/music_mentor/AGENTS.md"]).status, 0, "рабочая папка из template");
		const reg = sh("docker", ["exec", tag, "sh", "-c", "cat /home/.mm/learners/test1.json; ls /home/test1"]).stdout;
		assert.ok(!reg.includes(cfg.token), "токен на сервере открытым текстом");
		assert.match(reg, /"sha256":"[0-9a-f]{64}"/);
		assert.equal(sh("docker", ["exec", tag, "sh", "-c", "grep -rl '" + cfg.token + "' /home /etc /root /tmp 2>/dev/null | head"]).stdout.trim(), "", "токен нигде в контейнере");

		// веб-терминал: чужой токен — 403, свой — страница ttyd
		assert.equal((await fetch(`${url}/t/${"z".repeat(43)}/`)).status, 403);
		assert.equal((await fetch(`${url}/t/short/`)).status, 403);
		const page = await fetch(link);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /<title>/);
		// мост не включён: порт ученика закрывает соединение сразу
		const probe = sh("docker", ["exec", "-u", "test1", "-e", "HOME=/home/test1", tag, "node", "-e", PING_JS]);
		assert.match(probe.stdout, /closed/, `мост офлайн: ${probe.stdout}${probe.stderr}`);

		// мост на «стороне ученика»: тестовый fake_lom + remote.py по HTTP к контейнеру
		bridge = spawn("python3", [path.join(ROOT, "tests", "bridge", "run_remote_bridge.py"), d], { stdio: ["ignore", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("мост не вышел на связь")), 20_000);
			bridge!.stdout!.on("data", (c: Buffer) => { if (c.toString().includes("READY")) { clearTimeout(t); resolve(); } });
			bridge!.on("exit", () => reject(new Error("мост завершился")));
		});
		await new Promise((res) => setTimeout(res, 500));
		const ping = sh("docker", ["exec", "-u", "test1", "-e", "HOME=/home/test1", tag, "node", "-e", PING_JS]);
		assert.match(ping.stdout, /"pong":true/, `live ping через порт ученика: ${ping.stdout}${ping.stderr}`);
		// у второго ученика моста нет: отказ, чужой Live не виден
		const other = sh("docker", ["exec", "-u", "test2", "-e", "HOME=/home/test2", tag, "node", "-e", PING_JS]);
		assert.match(other.stdout, /closed/);
	} finally {
		bridge?.kill();
		if (started) sh("docker", ["rm", "-f", "-v", tag], { timeout: 60_000 });
		sh("docker", ["rmi", "-f", tag], { timeout: 60_000 });
		rmSync(tmp, { recursive: true, force: true });
	}
});

/** Как pi у ученика: порт моста из ~/.mm_bridge_port (так делает mentor_login), запрос — тем же транспортом (lib/mm/bridge.ts), что у live_ping. */
const PING_JS = `
const fs = require('fs');
process.env.MM_LIVE_PORT = fs.readFileSync(process.env.HOME + '/.mm_bridge_port', 'utf8').trim();
import('/opt/music_mentor_pkg/lib/mm/bridge.ts').then(async (m) => {
  try { console.log(JSON.stringify(await m.sendLine({ cmd: 'ping' }))); } catch (e) { console.log(e instanceof m.BridgeClosed ? 'closed' : 'error ' + e.message); }
});
`;
