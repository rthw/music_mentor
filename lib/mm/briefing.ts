/**
 * Сводка к началу сессии для агента: профиль ученика, свежие проекты, что изменилось с прошлого
 * снимка, идея из прошлого журнала и предупреждения (версия, баланс).
 *
 * Собирается из файлов ученика (learner/) и его проектов (.als). Сеть — только предупреждения:
 * их присылает расширение, чтобы lib не зависел от api.deepseek.com и pi.
 * Ошибки чтения не ломают урок: чего нет, того просто нет в сводке.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectDiff, type DiffResult } from "../als/diff.ts";
import { findProjects, type ProjectFile, projectRoots } from "../als/files.ts";
import { readProject, type Project } from "../als/parse.ts";

export const STATUSES = ["не встречал", "видел", "пробовал", "владеет"] as const;

export interface ProfileNode {
	topic: string;
	status: string;
	evidence: string;
}

export interface Profile {
	name: string;
	interests: string[];
	goals: string[];
	likes: string[];
	live: string;
	level: string;
	summary: string;
	nodes: ProfileNode[];
}

const MAX_PROFILE_CHARS = 1200;
const MAX_PROJECTS = 3;
const MAX_NODES = 12;

function unquote(v: string): string {
	const s = v.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).trim();
	return s;
}

function listValue(v: string): string[] {
	const s = unquote(v);
	if (!s) return [];
	if (s.startsWith("[") && s.endsWith("]")) {
		return s
			.slice(1, -1)
			.split(",")
			.map((x) => unquote(x))
			.filter(Boolean);
	}
	return s
		.split(",")
		.map((x) => unquote(x))
		.filter(Boolean);
}

/** Раздел `## Название` из тела markdown (до следующего заголовка второго уровня). */
export function section(body: string, title: string): string {
	const head = new RegExp(`^##\\s*${title}\\s*$`, "m").exec(body);
	if (!head) return "";
	const rest = body.slice(head.index + head[0].length);
	const next = /^##\s/m.exec(rest);
	return (next ? rest.slice(0, next.index) : rest).trim();
}

function parseNodes(text: string): ProfileNode[] {
	const out: ProfileNode[] = [];
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t.startsWith("|")) continue;
		const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
		if (cells.length < 2) continue;
		const [topic, status, evidence = ""] = cells;
		if (!topic || topic === "тема" || topic === "—" || /^-+$/.test(topic)) continue;
		if (/^-+$/.test(status)) continue;
		const norm = status.toLowerCase();
		if (!(STATUSES as readonly string[]).includes(norm)) continue;
		out.push({ topic, status: norm, evidence });
	}
	return out;
}

/** Профиль ученика из markdown: простой фронтматтер + `## Кратко` + таблица статусов. */
export function parseProfile(text: string): Profile {
	const p: Profile = { name: "", interests: [], goals: [], likes: [], live: "", level: "", summary: "", nodes: [] };
	let body = text;
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (fm) {
		body = fm[2];
		for (const line of fm[1].split(/\r?\n/)) {
			const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
			if (!m) continue;
			const key = m[1].toLowerCase();
			const raw = m[2];
			if (key === "name" || key === "live" || key === "level") p[key] = unquote(raw);
			else if (key === "interests" || key === "goals" || key === "likes") p[key] = listValue(raw);
		}
	}
	const summary = section(body, "Кратко");
	p.summary = summary
		.split(/\r?\n/)
		.filter((l) => !/^\s*\(.*\)\s*$/.test(l))
		.join("\n")
		.trim()
		.slice(0, MAX_PROFILE_CHARS);
	p.nodes = parseNodes(section(body, "Узлы и статусы"));
	return p;
}

/** Профиль, в котором ещё ничего нет: первая сессия. */
export function isEmptyProfile(p: Profile | undefined): boolean {
	if (!p) return true;
	return !p.name && !p.interests.length && !p.goals.length && !p.likes.length && !p.summary && !p.nodes.length;
}

function fmtDate(ms: number): string {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export interface LogEntry {
	date?: string;
	did?: string;
	worked?: string;
	next?: string;
}

/** Последняя строка журнала сессий (битые и пустые строки пропускаем). */
export function lastLogEntry(text: string | undefined): LogEntry | undefined {
	if (!text) return undefined;
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const v = JSON.parse(lines[i]);
			if (v && typeof v === "object") {
				const e: LogEntry = {};
				for (const k of ["date", "did", "worked", "next"] as const) if (typeof v[k] === "string" && v[k].trim()) e[k] = v[k].trim();
				if (e.next || e.did || e.worked) return e;
			}
		} catch {
			// не JSON — значит не строка журнала
		}
	}
	return undefined;
}

export interface BriefingData {
	cwd: string;
	profile?: Profile;
	projects: ProjectFile[];
	/** Сравнение самого свежего проекта с прошлым снимком (только у него). */
	diff?: { file: string; result: DiffResult };
	log?: LogEntry;
	warnings: string[];
}

function profileText(p: Profile): string {
	const lines: string[] = [];
	const who = [p.name && `Имя: ${p.name}`, p.live && `Live: ${p.live}`, p.level && `Уровень (гипотеза): ${p.level}`].filter(Boolean);
	if (who.length) lines.push(who.join(". ") + ".");
	if (p.interests.length) lines.push(`Слушает и любит: ${p.interests.join(", ")}.`);
	if (p.likes.length) lines.push(`Нравится в музыке: ${p.likes.join(", ")}.`);
	if (p.goals.length) lines.push(`Цели: ${p.goals.join(", ")}.`);
	if (p.summary) lines.push(`Кратко: ${p.summary}`);
	const nodes = p.nodes.slice(0, MAX_NODES).map((n) => `${n.topic} — ${n.status}${n.evidence && n.evidence !== "—" ? ` (${n.evidence})` : ""}`);
	if (nodes.length) lines.push(`Темы: ${nodes.join("; ")}.`);
	return lines.join("\n");
}

/** Текст сводки. Чистая функция: всё, что нужно, уже в данных. */
export function briefingText(d: BriefingData): string {
	const first = isEmptyProfile(d.profile);
	const out: string[] = ["# Сводка к началу сессии", "", "Это твоя память об ученике, не пересказывай её целиком. Используй как знание о нём."];
	out.push("", "## Профиль");
	if (first) {
		out.push(
			"Пусто — вы ещё не знакомы. Познакомься по скиллу `mentor`: не больше пяти вопросов по одному (имя, что слушает, чего хочет, сколько времени на сессию). Версию и редакцию Live узнай сам — по проекту или мосту, не спрашивай. Потом сам посмотри 2–3 свежих проекта и запиши `learner/profile.md`.",
		);
	} else {
		out.push(profileText(d.profile!));
	}

	out.push("", `## Свежие проекты${d.projects.length ? ` (${d.projects.length})` : ""}`);
	if (!d.projects.length) {
		out.push("Проектов `.als` не нашлось. Спроси, где они лежат, и повтори `project_list` с `extra_dirs`.");
	} else {
		d.projects.slice(0, MAX_PROJECTS).forEach((f, i) => out.push(`${i + 1}. ${f.path} — ${fmtDate(f.mtime)}, ${Math.round(f.size / 1024)} КБ`));
		const df = d.diff;
		if (df) {
			const name = path.basename(df.file).replace(/\.als$/i, "");
			out.push("", `### Что изменилось в «${name}» с прошлого раза`);
			out.push(df.result.first ? "Снимка не было — это первый: сравнивать не с чем (снимок записан)." : df.result.text);
		}
	}

	out.push("", "## Идея из прошлой сессии");
	const log = d.log;
	if (log?.next || log?.did) {
		const date = log.date ? `${log.date}: ` : "";
		out.push(log.next ? `${date}${log.next}` : `${date}${log.worked ?? log.did}`);
	} else {
		out.push("Журнала сессий ещё нет.");
	}

	if (d.warnings.length) {
		out.push("", "## Предупреждения");
		for (const w of d.warnings) out.push(`- ${w}`);
	}

	out.push("", "## С чего начать");
	if (first) {
		out.push("Сначала знакомство (скилл `mentor`). После знакомства посмотри проекты сам и предложи, с чего начать.");
	} else {
		out.push(
			"Начни ответ с одного конкретного наблюдения про его музыку — трек, клип, нотная деталь из анализа — и предложи три пути: улучшить этот трек / начать новый / разобраться в чём-то. Одной строкой скажи свой совет — следующий шаг.",
		);
	}
	return out.join("\n");
}

export interface BriefingDeps {
	roots?: string[];
	limit?: number;
	readText?: (file: string) => string | undefined;
	find?: (roots: string[], opts: { limit?: number }) => ProjectFile[];
	load?: (file: string) => Project;
	diff?: (project: Project, cwd: string, save: boolean) => DiffResult;
	/** Предупреждения (версия, баланс). По умолчанию — нет. */
	warnings?: () => Promise<(string | undefined)[]>;
	/** Сколько ждать предупреждений, чтобы урок не начинался с паузы. */
	warningTimeoutMs?: number;
}

export interface BriefingResult {
	text: string;
	firstSession: boolean;
	warnings: string[];
	projects: ProjectFile[];
}

function safeRead(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	if (!(ms > 0)) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

/** Собрать сводку к первому ходу сессии. Никогда не бросает: чего не смогли — того нет в тексте. */
export async function buildBriefing(cwd: string, deps: BriefingDeps = {}): Promise<BriefingResult> {
	const read = deps.readText ?? safeRead;
	const profileFile = path.join(cwd, "learner", "profile.md");
	const profile = (() => {
		const text = read(profileFile);
		return text ? parseProfile(text) : undefined;
	})();
	const firstSession = isEmptyProfile(profile);

	let projects: ProjectFile[] = [];
	try {
		projects = (deps.find ?? findProjects)(deps.roots ?? projectRoots(), { limit: deps.limit ?? MAX_PROJECTS });
	} catch {
		projects = [];
	}
	projects = projects.slice(0, MAX_PROJECTS);

	let diff: BriefingData["diff"];
	if (projects.length) {
		const file = projects[0].path;
		try {
			const project = (deps.load ?? readProject)(file);
			diff = { file, result: (deps.diff ?? projectDiff)(project, cwd, true) };
		} catch {
			// проект не прочитался — покажем без сравнения
		}
	}

	const log = lastLogEntry(read(path.join(cwd, "learner", "log.jsonl")));

	const warnings = ((await withTimeout(
		(deps.warnings ?? (async () => []))(),
		deps.warningTimeoutMs ?? 6000,
	)) ?? []).filter((w): w is string => typeof w === "string" && !!w.trim());

	const data: BriefingData = { cwd, profile, projects, diff, log, warnings };
	return { text: briefingText(data), firstSession, warnings, projects };
}

/** Есть ли у ученика профиль и журнал (для отчёта и тестов). */
export function hasLearnerFiles(cwd: string): boolean {
	return existsSync(path.join(cwd, "learner", "profile.md")) && existsSync(path.join(cwd, "learner", "log.jsonl"));
}
