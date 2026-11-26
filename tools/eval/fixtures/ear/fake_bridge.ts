/**
 * Поддельный мост MentorBridge для eval-сценария со слухом: тот же протокол (строка JSON на 9878),
 * те же ответы на ping/song/tracks/add_midi_track/add_clip/fire_clip/remove — но без Live и без звука.
 *
 * Зачем: сценарий 07 проверяет поведение (ведёт задания по одному, не выдаёт ответ), а не мост.
 * Настоящий мост проверяется вживую в VM (см. отчёт T1912); здесь важно, чтобы `ear_next` получил
 * «трек создан, клип лежит, играет» и ученику ничего не пришлось включать.
 *
 *   node tools/eval/fixtures/ear/fake_bridge.ts [порт]
 */

import net from "node:net";

const PREFIX = "Подсказка: ";
const port = Number(process.argv[2] ?? process.env.MM_LIVE_PORT ?? 9878);

interface Slot {
	slot: number;
	name: string;
	notes: { pitch: number; start: number; duration: number; velocity?: number }[];
}
interface Track {
	index: number;
	name: string;
	type: "midi" | "audio";
	slot_count: number;
	clips: Slot[];
}

const tracks: Track[] = [
	// трек ученика: в него мост не пишет клипы, и удалять его нельзя
	{ index: 0, name: "Bass", type: "midi", slot_count: 8, clips: [] },
];
let lastNotes: Slot | undefined;

function handle(r: any): any {
	switch (r.cmd) {
		case "ping":
			return { ok: true, result: { pong: true, bridge: "MentorBridge", version: 2, live: "12.4 (eval stub)", python: "stub", hint_prefix: PREFIX } };
		case "song":
			return { ok: true, result: { tempo: 100, signature: [4, 4], is_playing: true, track_count: tracks.length, scene_count: 8, selected_track: 0 } };
		case "tracks":
			return { ok: true, result: { tracks } };
		case "add_midi_track": {
			const index = tracks.length;
			const name = PREFIX + String(r.name ?? "идея").replace(PREFIX, "");
			tracks.push({ index, name, type: "midi", slot_count: 8, clips: [] });
			return { ok: true, result: { index, name } };
		}
		case "add_clip": {
			const track = tracks[Number(r.track)];
			if (!track) return { ok: false, error: `Трека ${r.track} нет.` };
			if (!track.name.startsWith(PREFIX)) return { ok: false, error: `Мост кладёт клипы только в свои треки «${PREFIX}…», а не в «${track.name}».` };
			if (track.clips.some((c) => c.slot === Number(r.slot))) return { ok: false, error: `Слот ${r.slot} на треке «${track.name}» занят.` };
			const notes = (r.notes ?? []).map((n: any) => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity }));
			const clip: Slot = { slot: Number(r.slot), name: PREFIX + String(r.name ?? "вариант").replace(PREFIX, ""), notes };
			track.clips.push(clip);
			lastNotes = clip;
			return { ok: true, result: { track: track.index, slot: clip.slot, name: clip.name, length: r.length_beats, note_count: notes.length } };
		}
		case "fire_clip": {
			const track = tracks[Number(r.track)];
			const clip = track?.clips.find((c) => c.slot === Number(r.slot));
			if (!clip) return { ok: false, error: `Слот ${r.slot} пуст: играть нечего.` };
			return { ok: true, result: { fired: true, track: track!.index, slot: clip.slot } };
		}
		case "stop":
			return { ok: true, result: { stopped: true } };
		case "clip_notes": {
			const track = tracks[Number(r.track)];
			const clip = track?.clips.find((c) => c.slot === Number(r.slot));
			if (!clip) return { ok: true, result: { exists: false, track: r.track, slot: r.slot } };
			return { ok: true, result: { exists: true, track: r.track, slot: clip.slot, name: clip.name, notes: clip.notes } };
		}
		case "last_clip": {
			const track = tracks.find((t) => t.name === r.track) ?? tracks[Number(r.track)];
			if (!track) return { ok: false, error: `В Live нет трека «${r.track}».` };
			if (!lastNotes) return { ok: true, result: { exists: false, track: track.index, name: track.name } };
			return { ok: true, result: { exists: true, is_midi_clip: true, track: track.index, track_name: track.name, slot: lastNotes.slot, name: lastNotes.name, how: "selected", notes: lastNotes.notes } };
		}
		case "remove": {
			const track = tracks[Number(r.track)];
			if (!track) return { ok: false, error: `Трека ${r.track} нет.` };
			if (!track.name.startsWith(PREFIX)) return { ok: false, error: `«${track.name}» — трек ученика, мост его не удаляет.` };
			if (r.confirmed !== true) return { ok: false, error: "Удалить трек можно только после явного «да» ученика." };
			tracks.splice(track.index, 1);
			return { ok: true, result: { removed: track.name, index: track.index } };
		}
		default:
			return { ok: false, error: `Неизвестная команда '${r.cmd}'. Есть: ping, song, tracks, clip_notes, last_clip, add_midi_track, add_clip, fire_clip, stop, remove.` };
	}
}

const server = net.createServer((sock) => {
	let buf = "";
	sock.setEncoding("utf8");
	sock.on("data", (d) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const req = JSON.parse(buf.slice(0, i));
			buf = buf.slice(i + 1);
			let resp: any;
			try {
				resp = handle(req);
			} catch (e) {
				resp = { ok: false, error: String((e as Error).message) };
			}
			sock.write(JSON.stringify(resp) + "\n");
		}
	});
});
server.listen(port, "127.0.0.1", () => console.log(`fake MentorBridge: 127.0.0.1:${port}`));
