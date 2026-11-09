/** Поиск .als: где лежат проекты, пути Windows и POSIX, Documents в OneDrive. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const SKIP_DIRS = new Set(["backup", "ableton project info", "node_modules", ".git", "samples", "presets", "$recycle.bin"]);

/** ~, %VAR%, обратные слэши Windows (на POSIX — только если иначе файла нет). */
export function normalizeUserPath(p: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
	let s = p.trim().replace(/^"(.*)"$/, "$1");
	s = s.replace(/%([^%]+)%/g, (m, name: string) => env[name] ?? env[name.toUpperCase()] ?? m);
	if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(homedir(), s.slice(1));
	if (platform() !== "win32" && s.includes("\\") && !existsSync(s)) s = s.replace(/\\/g, "/");
	return path.resolve(cwd, s);
}

/** Реальная папка «Документы» на Windows (может быть перенаправлена в OneDrive). */
function windowsDocuments(): string | undefined {
	if (platform() !== "win32") return undefined;
	try {
		const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('MyDocuments')"], { encoding: "utf8", timeout: 5000 });
		const p = out.trim();
		return p || undefined;
	} catch {
		return undefined;
	}
}

export function projectRoots(extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
	const home = homedir();
	const candidates: (string | undefined)[] = [windowsDocuments(), path.join(home, "Documents"), path.join(home, "Документы"), path.join(home, "Desktop"), path.join(home, "Рабочий стол")];
	// OneDrive: переменные среды и папки OneDrive* в домашней
	for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) if (env[k]) candidates.push(path.join(env[k]!, "Documents"), path.join(env[k]!, "Документы"), path.join(env[k]!, "Desktop"), path.join(env[k]!, "Рабочий стол"));
	try {
		for (const e of readdirSync(home, { withFileTypes: true })) {
			if (e.isDirectory() && /^onedrive/i.test(e.name)) candidates.push(path.join(home, e.name, "Documents"), path.join(home, e.name, "Документы"), path.join(home, e.name, "Desktop"), path.join(home, e.name, "Рабочий стол"));
		}
	} catch {
		/* нет домашней — не страшно */
	}
	for (const d of (env.MM_PROJECT_DIRS ?? "").split(path.delimiter)) if (d) candidates.push(d);
	for (const d of extra) candidates.push(normalizeUserPath(d));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of candidates) {
		if (!c) continue;
		const r = path.resolve(c);
		const k = r.toLowerCase();
		if (seen.has(k) || !existsSync(r)) continue;
		seen.add(k);
		out.push(r);
	}
	return out;
}

export interface ProjectFile {
	path: string;
	mtime: number;
	size: number;
}

export function findProjects(roots: string[], opts: { maxDepth?: number; limit?: number } = {}): ProjectFile[] {
	const maxDepth = opts.maxDepth ?? 6;
	const found = new Map<string, ProjectFile>();
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) walk(full, depth + 1);
			} else if (e.isFile() && /\.als$/i.test(e.name)) {
				try {
					const st = statSync(full);
					found.set(full.toLowerCase(), { path: full, mtime: st.mtimeMs, size: st.size });
				} catch {
					/* файл исчез */
				}
			}
		}
	};
	for (const r of roots) walk(r, 0);
	return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, opts.limit ?? 40);
}
