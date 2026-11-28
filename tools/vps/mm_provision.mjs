// Настройки pi ученика на сервере: то же, что Set-PiSettings / Set-PiGrowSettings / Set-DeepSeekAuth
// в lib/win/common.ps1, но пути Linux. Запуск (от имени ученика):
//   node mm_provision.mjs --home /home/ivan [--key-stdin]
// Ключ DeepSeek читается из stdin и нигде не печатается. Чужие поля settings.json (packages от `pi install`) сохраняются.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const home = opt("--home") ?? "";
const workspace = path.join(home, "music_mentor");
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");

function readJson(file) {
	if (!existsSync(file)) return {};
	const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	return raw.trim() ? JSON.parse(raw) : {};
}
function writeJson(file, obj, mode) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode });
	if (mode) chmodSync(file, mode);
}
const src = (e) => (typeof e === "string" ? e : e && typeof e.source === "string" ? e.source : "");
const norm = (p) => p.replace(/\\/g, "/");

export function mergeSettings(s, { workspace }) {
	s.defaultProvider = "deepseek";
	s.defaultModel = "deepseek-v4-pro";
	s.quietStartup = true;
	s.enabledModels = ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"];
	s.hideThinkingBlock = true; // ученику нужен ответ, а не рассуждения (T1909)
	const recipes = path.join(workspace, "learner", "recipes");
	const tools = path.join(workspace, "learner", "my_tools");
	const flag = path.join(workspace, "learner", "my_tools_disabled");
	// чужие записи не трогаем; старые пути к тем же папкам заменяем
	s.skills = [...(Array.isArray(s.skills) ? s.skills : []).filter((e) => e && !/(^|\/)learner\/recipes\/?$/.test(norm(String(e)))), recipes];
	const pkgs = (Array.isArray(s.packages) ? s.packages : []).filter((e) => e && !/(^|\/)learner\/my_tools\/?$/.test(norm(src(e))));
	if (!existsSync(flag)) pkgs.push(tools);
	s.packages = pkgs;
	return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!home) { console.error("нужен --home"); process.exit(2); }
	const sf = path.join(agentDir, "settings.json");
	writeJson(sf, mergeSettings(readJson(sf), { workspace }));
	if (argv.includes("--key-stdin")) {
		const key = readFileSync(0, "utf8").trim();
		if (key.length < 8) { console.error("ключ пустой или слишком короткий"); process.exit(1); }
		const af = path.join(agentDir, "auth.json");
		const a = readJson(af);
		a.deepseek = { type: "api_" + "key", key };
		writeJson(af, a, 0o600);
	}
	console.log("настройки pi записаны: " + sf);
}
