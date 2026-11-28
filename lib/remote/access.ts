/**
 * Слой доступа к файлам ученика: локальный режим (диск этой машины, Windows) и удалённый (MM_REMOTE_FILES=1,
 * файлы отдаёт мост). Расширения зовут только его; парсер .als и analyzeWav по-прежнему читают обычные файлы.
 */

import { findProjects, normalizeUserPath, projectRoots, type ProjectFile } from "../als/files.ts";
import { readProject, type Project } from "../als/parse.ts";
import { audioRoots, findWavs, type AudioFile } from "../audio/files.ts";
import { localFile, listRemote, type RemoteOpts } from "./client.ts";
import { isRemoteFiles } from "./paths.ts";

export { RemoteClosed } from "./client.ts";

export interface Listing<T> {
	files: T[];
	roots: string[];
}

export async function listProjects(extra: string[] = [], limit = 20, opts: RemoteOpts = {}): Promise<Listing<ProjectFile>> {
	if (isRemoteFiles()) return listRemote("als", { ...opts, extra, limit });
	const roots = projectRoots(extra);
	return { files: findProjects(roots, { limit }), roots };
}

export async function listWavs(extra: string[] = [], limit = 10, opts: RemoteOpts = {}): Promise<Listing<AudioFile>> {
	if (isRemoteFiles()) return listRemote("wav", { ...opts, extra, limit });
	const roots = audioRoots(extra);
	return { files: findWavs(roots, { limit }), roots };
}

/** Путь к реальному файлу для чтения. Удалённый режим — кэш; `shown` — путь, как его видит ученик. */
export async function localPath(cwd: string, p: string, opts: RemoteOpts = {}): Promise<{ shown: string; local: string }> {
	if (isRemoteFiles()) return localFile(p, opts);
	const full = normalizeUserPath(p, cwd);
	return { shown: full, local: full };
}

/** Проект .als целиком; в `project.file` — путь ученика, а не кэша. */
export async function loadProject(cwd: string, p: string, opts: RemoteOpts = {}): Promise<{ full: string; project: Project }> {
	const { shown, local } = await localPath(cwd, p, opts);
	const project = readProject(local);
	project.file = shown;
	return { full: shown, project };
}
