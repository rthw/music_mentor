/**
 * Разбор WAV без нативных зависимостей: PCM 8/16/24/32 бит, float 32/64, моно и стерео
 * (больше двух каналов — берём первые два). Читает файл кусками: 10-минутный трек
 * не загружается в память целиком.
 *
 * Понимает RIFF и RF64, WAVE_FORMAT_EXTENSIBLE, нечётные chunk'и и файлы, у которых размер
 * data записан нулём/0xFFFFFFFF (так пишут потоковые рендеры) — тогда data идёт до конца файла.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export class WavError extends Error {}

export interface WavInfo {
	channels: number;
	/** Сколько каналов реально читаем (1 или 2). */
	used: number;
	sampleRate: number;
	bits: number;
	format: "int" | "float";
	frames: number;
	dataStart: number;
	dataBytes: number;
	blockAlign: number;
	duration: number;
}

export const HOW_TO_WAV =
	"Читаю только wav. Как получить: перетащи файл на аудиодорожку в Ableton Live и экспортируй (File → Export Audio/Video, формат WAV).";

function readAt(fd: number, pos: number, len: number): Buffer {
	const buf = Buffer.alloc(len);
	const n = readSync(fd, buf, 0, len, pos);
	return n < len ? buf.subarray(0, n) : buf;
}

/** Не WAV: понятная причина по первым байтам. */
function notWavMessage(head: Buffer, path: string): string {
	const ascii = head.subarray(0, 12).toString("latin1");
	const isMp3 = ascii.startsWith("ID3") || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || /\.mp3$/i.test(path);
	if (isMp3) return `Это mp3, а не wav. ${HOW_TO_WAV}`;
	if (ascii.startsWith("fLaC")) return `Это flac, а не wav. ${HOW_TO_WAV}`;
	if (ascii.startsWith("OggS")) return `Это ogg, а не wav. ${HOW_TO_WAV}`;
	if (ascii.slice(4, 8) === "ftyp") return `Это m4a/aac, а не wav. ${HOW_TO_WAV}`;
	if (ascii.startsWith("FORM")) return `Это aiff, а не wav. ${HOW_TO_WAV}`;
	return `Файл не похож на wav (нет заголовка RIFF). ${HOW_TO_WAV}`;
}

export function readWavInfo(path: string): WavInfo {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (e) {
		throw new WavError(`Не открыть файл ${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
	}
	try {
		const size = fstatSync(fd).size;
		const head = readAt(fd, 0, 12);
		const tag = head.subarray(0, 4).toString("latin1");
		if ((tag !== "RIFF" && tag !== "RF64") || head.subarray(8, 12).toString("latin1") !== "WAVE") throw new WavError(notWavMessage(head, path));

		let pos = 12;
		let fmt: { tag: number; ch: number; rate: number; align: number; bits: number } | undefined;
		let rf64Data: number | undefined;
		while (pos + 8 <= size) {
			const h = readAt(fd, pos, 8);
			if (h.length < 8) break;
			const id = h.subarray(0, 4).toString("latin1");
			let len = h.readUInt32LE(4);
			const body = pos + 8;
			if (id === "ds64") {
				const d = readAt(fd, body, 16);
				if (d.length >= 16) rf64Data = Number(d.readBigUInt64LE(8));
			} else if (id === "fmt ") {
				const f = readAt(fd, body, Math.min(len, 40));
				if (f.length < 16) throw new WavError("Повреждён заголовок fmt: файл обрезан.");
				let t = f.readUInt16LE(0);
				if (t === 0xfffe && f.length >= 26) t = f.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE: формат в SubFormat
				fmt = { tag: t, ch: f.readUInt16LE(2), rate: f.readUInt32LE(4), align: f.readUInt16LE(12), bits: f.readUInt16LE(14) };
			} else if (id === "data") {
				if (!fmt) throw new WavError("В файле data идёт раньше fmt — такой wav не читаю.");
				if (len === 0xffffffff && rf64Data !== undefined) len = rf64Data;
				const avail = size - body;
				const dataBytes = len === 0 || len === 0xffffffff || len > avail ? avail : len;
				const isFloat = fmt.tag === 3;
				if (fmt.tag !== 1 && fmt.tag !== 3) throw new WavError(`Формат wav ${fmt.tag} не поддерживается (нужен PCM или float). Экспортируй в Live как обычный WAV.`);
				if (fmt.ch < 1) throw new WavError("В wav нет каналов.");
				const okBits = isFloat ? [32, 64] : [8, 16, 24, 32];
				if (!okBits.includes(fmt.bits)) throw new WavError(`Не читаю ${isFloat ? "float" : "PCM"} ${fmt.bits} бит. Экспортируй wav 16, 24 или 32 бита.`);
				const align = fmt.align || fmt.ch * (fmt.bits / 8);
				const frames = Math.floor(dataBytes / align);
				if (frames < 1) throw new WavError("В wav нет звуковых данных.");
				return {
					channels: fmt.ch,
					used: Math.min(2, fmt.ch),
					sampleRate: fmt.rate,
					bits: fmt.bits,
					format: isFloat ? "float" : "int",
					frames,
					dataStart: body,
					dataBytes: frames * align,
					blockAlign: align,
					duration: frames / fmt.rate,
				};
			}
			pos = body + len + (len & 1);
		}
		throw new WavError(fmt ? "В wav нет блока data." : "В wav нет блока fmt.");
	} finally {
		closeSync(fd);
	}
}

/** Куски по `framesPerBlock` кадров: массив каналов (1 или 2) Float32Array в диапазоне −1…1. */
export function* wavBlocks(path: string, info: WavInfo, framesPerBlock = 32768): Generator<Float32Array[]> {
	const fd = openSync(path, "r");
	try {
		const ab = new ArrayBuffer(framesPerBlock * info.blockAlign);
		const buf = Buffer.from(ab);
		const bytes = info.bits / 8;
		const ch = info.channels;
		const out: Float32Array[] = Array.from({ length: info.used }, () => new Float32Array(framesPerBlock));
		let done = 0;
		while (done < info.frames) {
			const want = Math.min(framesPerBlock, info.frames - done);
			const got = readSync(fd, buf, 0, want * info.blockAlign, info.dataStart + done * info.blockAlign);
			const n = Math.floor(got / info.blockAlign);
			if (n < 1) break;
			const chunk = out.map((a) => a.subarray(0, n));
			for (let c = 0; c < info.used; c++) {
				const dst = chunk[c];
				const off = c * bytes;
				if (info.format === "float" && info.bits === 32) {
					const v = new Float32Array(ab, 0, (n * info.blockAlign) / 4);
					const step = info.blockAlign / 4;
					for (let i = 0, j = c; i < n; i++, j += step) dst[i] = v[j];
				} else if (info.format === "float") {
					const dv = new DataView(ab);
					for (let i = 0; i < n; i++) dst[i] = dv.getFloat64(i * info.blockAlign + off, true);
				} else if (info.bits === 16) {
					const v = new Int16Array(ab, 0, (n * info.blockAlign) / 2);
					const step = info.blockAlign / 2;
					for (let i = 0, j = c; i < n; i++, j += step) dst[i] = v[j] / 32768;
				} else if (info.bits === 24) {
					for (let i = 0, p = off; i < n; i++, p += info.blockAlign) dst[i] = (((buf[p + 2] << 24) | (buf[p + 1] << 16) | (buf[p] << 8)) >> 8) / 8388608;
				} else if (info.bits === 32) {
					const v = new Int32Array(ab, 0, (n * info.blockAlign) / 4);
					const step = info.blockAlign / 4;
					for (let i = 0, j = c; i < n; i++, j += step) dst[i] = v[j] / 2147483648;
				} else {
					for (let i = 0, p = off; i < n; i++, p += info.blockAlign) dst[i] = (buf[p] - 128) / 128;
				}
			}
			yield chunk;
			done += n;
		}
	} finally {
		closeSync(fd);
	}
}
