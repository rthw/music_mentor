/**
 * Старт сессии агента: кладёт в контекст первого хода сводку — профиль ученика, свежие проекты,
 * что изменилось с прошлого снимка, идею из прошлого журнала, предупреждения о версии и балансе.
 *
 * Сеть (версия, баланс) — не чаще раза в сутки и не задерживает урок: если не успела за несколько
 * секунд, сводка уходит без предупреждений, а они догонят строкой в окне.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildBriefing, type BriefingResult } from "../lib/mm/briefing.ts";
import { balanceReminder, updateReminder } from "./update.ts";

/** Подмена частей старта сессии для тестов: по умолчанию — настоящая сводка и сеть раз в сутки. */
export interface SessionStartDeps {
	/** Подмена сборки сводки: в тестах — без сети и без проектов. */
	build?: (cwd: string) => Promise<BriefingResult>;
}

export default function (pi: ExtensionAPI, deps: SessionStartDeps = {}) {
	let pending: Promise<BriefingResult> | undefined;
	// Сводка — один раз на сессию: в контекст первого хода, а не каждого ответа.
	let sent = false;

	const build =
		deps.build ??
		((cwd: string) =>
			buildBriefing(cwd, {
				warnings: async () => (await Promise.all([updateReminder(), balanceReminder()])).filter((w): w is string => !!w),
			}));

	pi.on("session_start", (_event, ctx) => {
		sent = false;
		pending = build(ctx.cwd).catch(() => ({ text: "", firstSession: true, warnings: [], projects: [] }));
		// Предупреждения показываем в окне, как только они появились: сводка может уйти раньше.
		void pending.then((b) => {
			for (const w of b.warnings) {
				try {
					ctx.ui.notify(w, "warning");
				} catch {
					// нет UI — не наша беда
				}
			}
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (sent || event.messageType !== "user") return;
		sent = true;
		const b = await (pending ?? build(ctx.cwd));
		if (!b.text) return;
		return { message: { customType: "mentor-briefing", content: b.text, display: false } };
	});
}
