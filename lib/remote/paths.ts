/**
 * Режим «файлы через мост» (MM_REMOTE_FILES=1): pi работает на сервере, Live и диск ученика — у него.
 * Здесь только строки: без файловой системы и сети, чтобы lib/als/files.ts мог этим пользоваться.
 */

export function isRemoteFiles(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(1|true|yes|on)$/i.test((env.MM_REMOTE_FILES ?? "").trim());
}

const WIN_ABS = /^[A-Za-z]:[\\/]/;

export const isWinAbsolute = (s: string) => WIN_ABS.test(s) || s.startsWith("\\\\");

/** Имя файла из виндовского или POSIX-пути. */
export function winBase(p: string): string {
	return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function winDir(p: string): string {
	const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
	parts.pop();
	const sep = p.includes("\\") ? "\\" : "/";
	return parts.join(sep);
}

export function winJoin(base: string, rel: string): string {
	const sep = base.includes("\\") || isWinAbsolute(base) ? "\\" : "/";
	const tail = rel.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
	return base.replace(/[\\/]+$/, "") + sep + tail;
}

/** Путь ученика как есть: без кавычек, с обратными слэшами для `C:\…`. Не трогает ФС сервера. */
export function cleanRemotePath(p: string): string {
	const s = p.trim().replace(/^"(.*)"$/, "$1").trim();
	return isWinAbsolute(s) ? s.replace(/\//g, "\\") : s;
}
