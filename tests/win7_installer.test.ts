/**
 * T1938: установка для Win7 (PuTTY + мост) и заведение ученика на сервере.
 * Статические проверки шаблонов — всегда; тест new_learner.sh против временного контейнера — если есть docker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const VPS = path.join(ROOT, "tools", "vps");
const WIN7 = path.join(VPS, "win7");
const read = (p: string) => readFileSync(p, "utf8");

test("win7: .cmd-файлы и PowerShell-скрипт только ASCII (cmd Win7 живёт в cp866)", () => {
	for (const f of ["install_win7.cmd", "start_mentor.cmd.tmpl", "win7_shortcut.ps1"]) {
		const t = readFileSync(path.join(WIN7, f));
		for (let i = 0; i < t.length; i++) assert.ok(t[i] < 128, `${f}: не-ASCII байт на позиции ${i}`);
	}
});

test("win7: лаунчер — -hostkey обязателен, туннель к 9878, понятный текст при сбое сети", () => {
	const t = read(path.join(WIN7, "start_mentor.cmd.tmpl"));
	assert.match(t, /-hostkey \{\{HOSTKEY\}\}/);
	assert.match(t, /-R \{\{BRIDGE_PORT\}\}:127\.0\.0\.1:9878/);
	assert.match(t, /-i "%~dp0\{\{PPK\}\}"/);
	assert.match(t, /\/wait/, "ждём закрытия PuTTY, иначе код выхода не увидеть");
	assert.match(t, /if errorlevel 1 goto failed/);
	assert.match(t, /:failed[\s\S]*connection to the server failed[\s\S]*pause/);
	assert.match(t, /host key changed/i);
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
	assert.ok(!/irm|iex|Invoke-Expression|DownloadFile|Invoke-WebRequest/i.test(t), "ничего из сети");
	// каждый goto ведёт на существующую метку
	const labels = new Set([...t.matchAll(/^:(\w+)/gm)].map((m) => m[1].toLowerCase()));
	for (const g of t.matchAll(/goto (\w+)/gi)) assert.ok(g[1].toLowerCase() === "eof" || labels.has(g[1].toLowerCase()), `goto ${g[1]} без метки`);
	// PowerShell 2.0: ярлык строится без возможностей новее
	const ps = read(path.join(WIN7, "win7_shortcut.ps1"));
	assert.ok(!/Set-Clipboard|ConvertFrom-Json|Invoke-RestMethod|\?\./.test(ps), "PS 2.0");
	const codes = ps.match(/\$codes = ([\d,]+)/)![1].split(",").map(Number);
	assert.equal(String.fromCharCode(...codes), "Музыкальный наставник");
});

test("sshd_mm.conf: ученики по группе, а не по списку; только ключ; туннель — только обратный", () => {
	const t = read(path.join(VPS, "sshd_mm.conf"));
	assert.match(t, /^AllowGroups mentors$/m);
	assert.match(t, /^Match Group mentors$/m);
	assert.ok(!/AllowUsers|Match User/.test(t));
	assert.match(t, /^PasswordAuthentication no$/m);
	assert.match(t, /^AllowTcpForwarding remote$/m);
	const d = read(path.join(VPS, "Dockerfile"));
	assert.match(d, /groupadd mentors/);
	assert.match(d, /putty-tools/);
	assert.ok(!/useradd[^\n]*drug/.test(d), "ученика в образе больше нет");
	const l = read(path.join(VPS, "mentor_login.sh"));
	assert.match(l, /MM_LIVE_PORT/);
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
});

// --- new_learner.sh против временного контейнера -----------------------------------------------------

function sh(cmd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
	return spawnSync(cmd, args, { encoding: "utf8", input: opts.input, env: { ...process.env, ...opts.env }, timeout: opts.timeout ?? 600_000 });
}
const hasDocker = sh("docker", ["info"], { timeout: 30_000 }).status === 0;
const skipDocker = hasDocker ? false : "docker недоступен";
const hasUnzip = sh("unzip", ["-v"]).status === 0;
const skipUnzip = skipDocker || (hasUnzip ? false : "нет unzip");

test("new_learner.sh на чистом контейнере: zip с нужным составом, ключ входит в pi, ключ DeepSeek не утёк", { skip: skipUnzip, timeout: 900_000 }, async () => {
	const tag = `mm_vps_test_${process.pid}`;
	const tmp = mkdtempSync(path.join(tmpdir(), "mm_nl_"));
	const assets = path.join(tmp, "assets");
	mkdirSync(assets);
	writeFileSync(path.join(assets, "putty.exe"), "MZ-fake-putty");
	writeFileSync(path.join(assets, "vc_redist.x64.exe"), "MZ-fake-vc");
	const fakeKey = "sk" + "-testtesttesttest1234567890abcd"; // не литералом: тест «в репо нет ключей» ищет такой вид
	let started = false;
	try {
		const b = sh("docker", ["build", "-q", "-t", tag, VPS]);
		assert.equal(b.status, 0, `docker build: ${b.stderr}`);
		const r = sh("docker", ["run", "-d", "--name", tag, tag]);
		assert.equal(r.status, 0, r.stderr);
		started = true;
		await new Promise((res) => setTimeout(res, 1500));
		const ip = sh("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", tag]).stdout.trim();
		const env = { MM_CONTAINER: tag, MM_BUNDLES_DIR: path.join(tmp, "bundles"), MM_WIN7_ASSETS: assets, MM_SKIP_ASSET_SHA: "1", MM_DEEPSEEK_KEY: fakeKey };

		// плохие имена отвергаются
		assert.notEqual(sh(path.join(VPS, "new_learner.sh"), ["Bad Name", "--host", ip], { env }).status, 0);

		const out1 = sh(path.join(VPS, "new_learner.sh"), ["test1", "--host", ip, "--port", "22"], { env });
		assert.equal(out1.status, 0, out1.stdout + out1.stderr);
		assert.ok(!(out1.stdout + out1.stderr).includes(fakeKey), "ключ DeepSeek в выводе");
		const out2 = sh(path.join(VPS, "new_learner.sh"), ["test2", "--host", ip], { env });
		assert.equal(out2.status, 0, out2.stdout + out2.stderr);
		assert.match(out2.stdout, /порт туннеля 9902/, "у второго ученика свой порт");

		// состав zip
		const zip = path.join(tmp, "bundles", "test1.zip");
		assert.ok(existsSync(zip));
		const x = path.join(tmp, "x");
		assert.equal(sh("unzip", ["-q", zip, "-d", x]).status, 0);
		const d = path.join(x, "test1");
		for (const f of ["putty.exe", "vc_redist.x64.exe", "test1.ppk", "install_win7.cmd", "Muzykalnyj nastavnik.cmd", "README.txt", "win7_shortcut.ps1", "MentorBridge/__init__.py", "MentorBridge/server.py"]) {
			assert.ok(existsSync(path.join(d, f)), `в zip нет ${f}`);
		}
		const launcher = read(path.join(d, "Muzykalnyj nastavnik.cmd"));
		assert.ok(launcher.includes("\r\n"), "CRLF");
		assert.ok(!/\{\{/.test(launcher), "остались заглушки");
		const hostkey = sh("docker", ["exec", tag, "sh", "-c", "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'"]).stdout.trim();
		assert.ok(launcher.includes(`-hostkey ${hostkey}`), "hostkey сервера в лаунчере");
		assert.ok(launcher.includes(`test1@${ip} -P 22`));
		assert.ok(launcher.includes("-R 9901:127.0.0.1:9878"));
		assert.ok(read(path.join(d, "README.txt")).startsWith("\uFEFF"), "README с BOM для Блокнота");
		assert.ok(read(path.join(d, "test1.ppk")).startsWith("PuTTY-User-Key-File-"));
		for (const f of ["install_win7.cmd", "win7_shortcut.ps1"]) assert.ok(!/sk-/.test(read(path.join(d, f))));

		// на сервере: настройки, ключ DeepSeek только у ученика, закрытого ключа нет
		const settings = JSON.parse(sh("docker", ["exec", tag, "cat", "/home/test1/.pi/agent/settings.json"]).stdout);
		assert.equal(settings.defaultModel, "deepseek-v4-pro");
		assert.ok(settings.packages.includes("/home/test1/music_mentor/learner/my_tools"));
		assert.ok(settings.packages.some((p: string) => p.includes("music_mentor_pkg")), "pi install записал пакет");
		const auth = JSON.parse(sh("docker", ["exec", tag, "cat", "/home/test1/.pi/agent/auth.json"]).stdout);
		assert.equal(auth.deepseek.key, fakeKey);
		const st = sh("docker", ["exec", tag, "stat", "-c", "%a", "/home/test1/.pi/agent/auth.json"]).stdout.trim();
		assert.equal(st, "600");
		assert.equal(sh("docker", ["exec", tag, "test", "-f", "/home/test1/music_mentor/AGENTS.md"]).status, 0, "рабочая папка из template");
		assert.ok(!sh("docker", ["exec", tag, "sh", "-c", "ls /tmp/tmp.* 2>/dev/null; ls /home/test1/.ssh"]).stdout.includes("id_ed25519"), "закрытого ключа на сервере нет");

		// вход по ключу из zip: puttygen переводит .ppk обратно в OpenSSH
		const key = path.join(tmp, "k");
		const cv = sh("docker", ["run", "--rm", "-i", "--entrypoint", "sh", tag, "-c", "cat > /tmp/a.ppk && puttygen /tmp/a.ppk -O private-openssh-new -o /tmp/a.key && cat /tmp/a.key"], { input: read(path.join(d, "test1.ppk")) });
		assert.equal(cv.status, 0, cv.stderr);
		writeFileSync(key, cv.stdout);
		chmodSync(key, 0o600);
		const kh = path.join(tmp, "kh");
		writeFileSync(kh, sh("ssh-keyscan", ["-t", "ed25519", ip]).stdout);
		const sshArgs = ["-tt", "-i", key, "-o", `UserKnownHostsFile=${kh}`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-R", "9901:127.0.0.1:9878", `test1@${ip}`];
		const got = await new Promise<string>((resolve) => {
			const p = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
			let buf = "";
			const done = () => { try { p.kill(); } catch { /* уже завершён */ } resolve(buf); };
			const timer = setTimeout(done, 25_000);
			const onData = (c: Buffer) => { buf += c.toString("utf8"); if (buf.includes("deepseek-v4-pro")) { clearTimeout(timer); done(); } };
			p.stdout.on("data", onData);
			p.stderr.on("data", onData);
			p.on("close", () => { clearTimeout(timer); resolve(buf); });
		});
		assert.ok(got.includes("deepseek-v4-pro"), `вход по ключу не привёл в pi: ${got.slice(0, 400)}`);

		// чужой порт для туннеля и обычная оболочка недоступны
		const bad = sh("ssh", ["-i", key, "-o", `UserKnownHostsFile=${kh}`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-R", "9999:127.0.0.1:1", `test1@${ip}`, "true"], { timeout: 30_000 });
		assert.notEqual(bad.status, 0, "туннель на чужой порт должен отклоняться");
	} finally {
		if (started) sh("docker", ["rm", "-f", tag], { timeout: 60_000 });
		sh("docker", ["rmi", "-f", tag], { timeout: 60_000 });
		rmSync(tmp, { recursive: true, force: true });
	}
});
