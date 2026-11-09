/**
 * Мост к запущенному Ableton Live (Remote Script MentorBridge, TCP 127.0.0.1:9878, JSON-строки).
 *
 * live_ping, live_state, live_clip_notes, live_browser — чтение «что сейчас в Live».
 * live_add_track, live_add_clip, live_load_device, live_set_param, live_remove — запись только добавлением
 * (запрет на правку проекта ученика проверяет сам мост, см. bridge/MentorBridge/commands.py).
 * live_play, live_stop — воспроизведение, только по просьбе ученика.
 * Перед первой записью за сессию текущий .als копируется в learner/backups/<дата>_<имя>.als.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Type } from "typebox";
import { findProjects, normalizeUserPath, projectRoots } from "../lib/als/files.ts";

export const DEFAULT_PORT = 9878;
const TIMEOUT_MS = 35_000;

export function bridgeAddress(env: NodeJS.ProcessEnv = process.env) {
	return { host: env.MM_LIVE_HOST || "127.0.0.1", port: Number(env.MM_LIVE_PORT) || DEFAULT_PORT };
}

export class BridgeClosed extends Error {}

/** Одна строка JSON туда, одна обратно. */
export function sendLine(req: object, addr = bridgeAddress()): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ host: addr.host, port: addr.port });
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("Live не ответил за 35 секунд. Возможно, открыт модальный диалог (сохранение, ошибка) — закрой его и повтори."));
		}, TIMEOUT_MS);
		sock.setEncoding("utf8");
		sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
		sock.on("data", (d) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i >= 0) {
				clearTimeout(timer);
				sock.end();
				try {
					resolve(JSON.parse(buf.slice(0, i)));
				} catch {
					reject(new Error("Мост ответил не JSON-ом: " + buf.slice(0, 200)));
				}
			}
		});
		sock.on("error", (e: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" ? new BridgeClosed(e.code) : e);
		});
	});
}

function liveRunning(): Promise<boolean | undefined> {
	if (process.platform !== "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("tasklist", ["/FI", "IMAGENAME eq Ableton Live*", "/FO", "CSV", "/NH"], { timeout: 5000 }, (err, out) => resolve(err ? undefined : /Ableton Live/i.test(out)));
	});
}

/** Шаги включения Control Surface; вкладка зависит от версии Live. */
export function enableSteps(): string {
	return [
		"Окно Live должно быть открыто, а мост выключен. Включить его надо один раз:",
		"1. Открой настройки Live: Options → Preferences (на Windows Ctrl+запятая).",
		"2. Вкладка: в Live 11 и в Live 12 до 12.3 — «Link, Tempo & MIDI» (иногда «Link/Tempo/MIDI»); в новых Live 12 (проверено на 12.4) она называется «Tempo & MIDI», рядом отдельная «Link»; в Live 10 — «Link MIDI».",
		"3. В блоке Control Surface выбери в свободной строке MentorBridge. Input и Output оставь None.",
		"4. Закрой настройки и скажи мне — я проверю связь.",
		"Если MentorBridge в списке нет: Live надо перезапустить после установки, и проверь, что папка MentorBridge лежит в User Library\\Remote Scripts.",
	].join("\n");
}

async function closedMessage(): Promise<string> {
	const running = await liveRunning();
	if (running === false) return "Ableton Live не запущен. Запусти Live, открой проект и повтори. Если мост ещё не включён:\n" + enableSteps();
	return "Live запущен (или я не смог это проверить), но мост MentorBridge не отвечает на порту 9878. " + enableSteps();
}

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

/** Вызов моста: ok:false превращается в исключение с объяснением моста (оно уже по-русски). */
export async function call(req: object, addr = bridgeAddress()): Promise<any> {
	let resp: any;
	try {
		resp = await sendLine(req, addr);
	} catch (e) {
		if (e instanceof BridgeClosed) throw new Error(await closedMessage());
		throw e;
	}
	if (!resp.ok) throw new Error(resp.error ?? "мост вернул ошибку без текста");
	return resp.result;
}

const json = (v: unknown) => JSON.stringify(v);

/** Копия текущего .als в learner/backups. Возвращает путь копии или объяснение, почему её нет. */
export async function backupProject(cwd: string, addr = bridgeAddress(), now = new Date()): Promise<{ path?: string; note?: string }> {
	let src: string | undefined;
	try {
		const song = await call({ cmd: "song" }, addr);
		if (typeof song.file_path === "string" && song.file_path) src = normalizeUserPath(song.file_path, cwd);
	} catch {
		// file_path есть не во всех версиях Live; ниже запасной путь
	}
	if (!src || !existsSync(src)) {
		const files = findProjects(projectRoots([cwd]), { limit: 1 });
		src = files[0]?.path;
	}
	if (!src) return { note: "проект ещё не сохранён на диск — копировать нечего" };
	const dir = path.join(cwd, "learner", "backups");
	mkdirSync(dir, { recursive: true });
	const stamp = now.toISOString().slice(0, 10);
	const dest = path.join(dir, `${stamp}_${path.basename(src)}`);
	copyFileSync(src, dest);
	return { path: dest };
}

export default function (pi: ExtensionAPI) {
	let backedUp = false;
	const addr = () => bridgeAddress();

	/** Перед первой записью за сессию — копия .als. Не удалась — запись не делаем. */
	async function beforeWrite(cwd: string): Promise<string> {
		if (backedUp) return "";
		try {
			const b = await backupProject(cwd, addr());
			backedUp = true;
			return b.path ? `Копия проекта до правок: ${b.path}. ` : `Копии нет: ${b.note}. `;
		} catch (e) {
			throw new Error(`Не смог сделать копию проекта перед правкой (${(e as Error).message}); в Live ничего не менял.`);
		}
	}
	const undoHint = "Всё добавленное отменяется в Live через Ctrl+Z.";

	const trackRef = Type.Union([Type.Number(), Type.String()], { description: "Номер трека (с 0) или точное имя" });

	pi.registerTool({
		name: "live_ping",
		label: "Связь с Live",
		description: "Проверить связь с запущенным Ableton Live через мост MentorBridge и узнать версию Live и моста. Если моста нет — вернёт шаги включения.",
		promptSnippet: "Проверить связь с Live, узнать версию",
		parameters: Type.Object({}),
		async execute() {
			const r = await call({ cmd: "ping" }, addr());
			return text(`Связь есть. Ableton Live ${r.live ?? "?"}, мост ${r.bridge} v${r.version} (Python ${r.python}).`, r);
		},
	});

	pi.registerTool({
		name: "live_state",
		label: "Состояние Live",
		description: "Что сейчас в запущенном Live: темп, размер, play, выбранные трек и сцена, все треки с устройствами и клипами в слотах (имя, длина, число нот). Arrangement в Live 10 не отдаётся — его читай из .als.",
		promptSnippet: "Состояние запущенного Live: треки, устройства, клипы",
		parameters: Type.Object({}),
		async execute() {
			const [song, tracks] = await Promise.all([call({ cmd: "song" }, addr()), call({ cmd: "tracks" }, addr())]);
			const lines = [`Темп ${song.tempo}, размер ${song.signature.join("/")}, ${song.is_playing ? "играет" : "стоит"}; треков ${song.track_count}, сцен ${song.scene_count}.`];
			if (song.scale) lines.push(`Лад в Live: ${json(song.scale)}`);
			for (const t of tracks.tracks) {
				const dev = t.devices.map((d: any) => d.name).join(" → ") || "без устройств";
				const clips = t.clips.map((c: any) => `слот ${c.slot}: «${c.name}» ${c.length} долей${c.is_midi_clip ? `, ${c.note_count} нот` : ", аудио"}`).join("; ") || "клипов нет";
				lines.push(`${t.index}. «${t.name}» (${t.type}${t.hint ? ", подсказка" : ""}) — ${dev}; ${clips}`);
			}
			return text(lines.join("\n"), { song, tracks: tracks.tracks });
		},
	});

	pi.registerTool({
		name: "live_clip_notes",
		label: "Ноты клипа в Live",
		description: "Ноты MIDI-клипа в запущенном Live (то, что ученик видит прямо сейчас, даже несохранённое).",
		promptSnippet: "Ноты клипа из запущенного Live",
		parameters: Type.Object({ track: trackRef, slot: Type.Number({ description: "Номер слота (сцены), с 0" }) }),
		async execute(_id, p) {
			const r = await call({ cmd: "clip_notes", track: p.track, slot: p.slot }, addr());
			if (!r.exists) return text("В этом слоте нет клипа.", r);
			const rows = r.notes.map((n: any) => `${n.pitch} @${n.start} дл ${n.duration} vel ${n.velocity}`);
			return text(`Клип «${r.name}», длина ${r.length} долей, нот ${rows.length}:\n${rows.join("\n")}`, r);
		},
	});

	pi.registerTool({
		name: "live_browser",
		label: "Браузер Live",
		description: "Какие инструменты, эффекты и пресеты есть в Live ученика (в его редакции). Без path — разделы; с path вида 'instruments' или 'instruments/Wavetable' — содержимое. Перед live_load_device смотри сюда, а не угадывай.",
		promptSnippet: "Что есть в браузере Live ученика (его редакция)",
		parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
		async execute(_id, p) {
			const r = await call({ cmd: "browser", path: p.path, limit: p.limit }, addr());
			if (r.roots) return text("Разделы: " + r.roots.join(", "), r);
			const rows = r.children.map((c: any) => (c.loadable ? c.name : `${c.name}/`));
			return text(`${r.path}${r.loadable ? " (загружаемый)" : ""}: ${r.total} элементов${r.total > rows.length ? `, показаны ${rows.length}` : ""}\n${rows.join("\n")}`, r);
		},
	});

	pi.registerTool({
		name: "live_add_track",
		label: "Добавить трек-подсказку",
		description: "Добавить в Live новый MIDI-трек «Подсказка: <имя>» фиксированного цвета. Трек ученика не трогает.",
		promptSnippet: "Добавить MIDI-трек «Подсказка: …» в Live",
		parameters: Type.Object({ name: Type.String({ description: "Имя без префикса «Подсказка: »" }) }),
		async execute(_id, p, _s, _u, ctx) {
			const pre = await beforeWrite(ctx.cwd);
			const r = await call({ cmd: "add_midi_track", name: p.name }, addr());
			return text(`${pre}Добавлен трек ${r.index} «${r.name}». ${undoHint}`, r);
		},
	});

	pi.registerTool({
		name: "live_add_clip",
		label: "Добавить клип",
		description:
			"Положить MIDI-клип «Подсказка: <имя>» в ПУСТОЙ слот трека-подсказки или MIDI-трека ученика. В занятый слот мост не пишет и существующие клипы не меняет. " +
			"Ноты: pitch (0–127), start и duration в долях (четвертях) от начала клипа, velocity (1–127, по умолчанию 100).",
		promptSnippet: "Положить MIDI-клип «Подсказка: …» в пустой слот",
		parameters: Type.Object({
			track: trackRef,
			slot: Type.Number({ description: "Номер пустого слота, с 0" }),
			length_beats: Type.Number({ description: "Длина клипа в долях, 4 = такт 4/4" }),
			notes: Type.Array(Type.Object({ pitch: Type.Number(), start: Type.Number(), duration: Type.Number(), velocity: Type.Optional(Type.Number()) })),
			name: Type.String({ description: "Имя без префикса" }),
		}),
		async execute(_id, p, _s, _u, ctx) {
			const pre = await beforeWrite(ctx.cwd);
			const r = await call({ cmd: "add_clip", ...p }, addr());
			return text(`${pre}Клип «${r.name}» лежит на треке ${r.track}, слот ${r.slot}: ${r.note_count} нот, ${r.length} долей. ${undoHint}`, r);
		},
	});

	pi.registerTool({
		name: "live_load_device",
		label: "Загрузить устройство",
		description: "Загрузить инструмент или эффект на ТРЕК-ПОДСКАЗКУ по пути из live_browser (например instruments/Wavetable). На треки ученика мост устройства не грузит.",
		promptSnippet: "Загрузить инструмент/эффект на трек-подсказку",
		parameters: Type.Object({ track: trackRef, path: Type.String({ description: "Путь из live_browser" }) }),
		async execute(_id, p, _s, _u, ctx) {
			const pre = await beforeWrite(ctx.cwd);
			const r = await call({ cmd: "load_device", ...p }, addr());
			return text(`${pre}Загружено «${r.loaded}»; на треке ${r.track} теперь: ${r.devices.join(" → ")}. ${undoHint}`, r);
		},
	});

	pi.registerTool({
		name: "live_set_param",
		label: "Параметр устройства",
		description: "Выставить параметр устройства на ТРЕКЕ-ПОДСКАЗКЕ (значение числом или строкой, как её показывает Live: «1/8», «50 %»). Устройства ученика мост не меняет.",
		promptSnippet: "Параметр устройства на треке-подсказке",
		parameters: Type.Object({ track: trackRef, device: Type.Union([Type.Number(), Type.String()]), param: Type.String(), value: Type.Union([Type.Number(), Type.String()]) }),
		async execute(_id, p, _s, _u, ctx) {
			const pre = await beforeWrite(ctx.cwd);
			const r = await call({ cmd: "set_param", ...p }, addr());
			return text(`${pre}${r.device}: ${r.param} = ${r.display}.`, r);
		},
	});

	pi.registerTool({
		name: "live_remove",
		label: "Убрать трек-подсказку",
		description: "Удалить трек-подсказку. Только после явного «да» ученика в чате: сначала спроси, потом вызывай с confirmed=true. Треки ученика удалить нельзя.",
		promptSnippet: "Удалить трек-подсказку (после «да» ученика)",
		parameters: Type.Object({ track: trackRef, confirmed: Type.Boolean({ description: "true только если ученик в чате сказал «да»" }) }),
		async execute(_id, p, _s, _u, ctx) {
			const pre = await beforeWrite(ctx.cwd);
			const r = await call({ cmd: "remove", ...p }, addr());
			return text(`${pre}Трек «${r.removed}» убран. ${undoHint}`, r);
		},
	});

	pi.registerTool({
		name: "live_play",
		label: "Запустить клип",
		description: "Запустить клип в слоте. Только по просьбе ученика.",
		promptSnippet: "Запустить клип в Live (только по просьбе)",
		parameters: Type.Object({ track: trackRef, slot: Type.Number() }),
		async execute(_id, p) {
			const r = await call({ cmd: "fire_clip", ...p }, addr());
			return text(`Запущен клип: трек ${r.track}, слот ${r.slot}.`, r);
		},
	});

	pi.registerTool({
		name: "live_stop",
		label: "Остановить Live",
		description: "Остановить воспроизведение и все клипы.",
		promptSnippet: "Остановить воспроизведение в Live",
		parameters: Type.Object({}),
		async execute() {
			await call({ cmd: "stop" }, addr());
			return text("Остановлено.");
		},
	});
}
