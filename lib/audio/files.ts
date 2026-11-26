/** Поиск свежих wav: папки проектов, Документы, рабочий стол, Загрузки, Музыка. */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { projectRoots } from "../als/files.ts";

export interface AudioFile {
	path: string;
	mtime: number;
	size: number;
}

const SKIP = new Set(["backup", "ableton project info", "node_modules", ".git", "samples", "presets", "$recycle.bin", "appdata"]);

export function audioRoots(extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
	const home = homedir();
	const more = [path.join(home, "Downloads"), path.join(home, "Загрузки"), path.join(home, "Music"), path.join(home, "Музыка")];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of [...projectRoots(extra, env), ...more.filter((d) => safeIsDir(d))]) {
		const k = path.resolve(r).toLowerCase();
		if (!seen.has(k)) {
			seen.add(k);
			out.push(path.resolve(r));
		}
	}
	return out;
}

function safeIsDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** .wav в папках, свежие сверху. Папки Samples/Backup пропускаются; обход ограничен по числу папок. */
export function findWavs(roots: string[], opts: { maxDepth?: number; limit?: number; maxDirs?: number } = {}): AudioFile[] {
	const maxDepth = opts.maxDepth ?? 5;
	let budget = opts.maxDirs ?? 4000;
	const found = new Map<string, AudioFile>();
	const walk = (dir: string, depth: number) => {
		if (budget-- <= 0) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (depth < maxDepth && !SKIP.has(e.name.toLowerCase())) walk(full, depth + 1);
			} else if (e.isFile() && /\.wav$/i.test(e.name)) {
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
	return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, opts.limit ?? 20);
}
