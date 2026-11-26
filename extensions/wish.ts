/**
 * Заявки автору: wish_send.
 *
 *   action=draft  — агент составил заявку; инструмент возвращает текст, который надо показать ученику дословно;
 *   action=send   — отправить дословный черновик, но только если следующее сообщение ученика — «да»
 *                   (замок ConsentGate в lib/mm/wish.ts: его ведёт событие input pi, а не модель);
 *   action=cancel — выбросить черновик.
 *
 * Нет сети — заявка пишется в learner/wishes.md, на старте сессии (раз в сутки) уходит повторно.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { quietRender } from "../lib/mm/quiet.ts";
import { ConsentGate, fileGateStore, proto, retryPending, submitWish, wishesFile, type PostDeps } from "../lib/mm/wish.ts";

export interface WishDeps extends PostDeps {
	root?: string;
	/** Где хранить состояние замка согласия (в тестах — своя папка); по умолчанию системный временный каталог. */
	stateDir?: string;
}

function appVersion(): string {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
	} catch {
		return "";
	}
}

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

export default function (pi: ExtensionAPI, deps: WishDeps = {}) {
	const gates = new Map<string, ConsentGate>();
	const gateFor = (cwd: string): ConsentGate => {
		let g = gates.get(cwd);
		if (!g) gates.set(cwd, (g = new ConsentGate(fileGateStore(cwd, deps.stateDir))));
		return g;
	};
	const post = (): PostDeps => ({ ...deps, version: deps.version ?? appVersion() });

	// Каждое сообщение ученика двигает счётчик; сообщения, которые агент сам себе отправил, не считаем.
	pi.on("input", (event: any, ctx: any) => {
		if (event?.source === "extension") return;
		gateFor(ctx.cwd).onUserInput(String(event?.text ?? ""));
	});

	// Ожидающие заявки уходят при старте сессии, не чаще раза в сутки; молча.
	pi.on("session_start", (_e: any, ctx: any) => {
		void retryPending(ctx.cwd, { ...post(), root: deps.root }).catch(() => undefined);
	});

	pi.registerTool({
		name: "wish_send",
		label: "Заявка автору",
		description:
			"Передать заявку автору агента, когда ученику не хватает умения, которое не решается рецептом (recipe_save) или маленькой своей функцией (my_tools_save). Сначала action=draft с текстом заявки (что хочет ученик, зачем, пример): инструмент вернёт текст, который ты показываешь ученику дословно и спрашиваешь «отправить Максу?». Только если его следующее сообщение — «да», вызывай action=send (отправится именно показанный текст). Без согласия отправить нельзя. Одна заявка на тему, не спамь; имя ученика в заявку не пиши (только «ученик»), личные данные и файлы его проектов — только с его явного согласия на каждый пункт.",
		promptSnippet: "Заявка автору в Telegram: draft → показать ученику → после «да» send",
		parameters: Type.Object({
			action: Type.String({ description: "draft | send | cancel" }),
			text: Type.Optional(Type.String({ description: "для draft: текст заявки, по-русски, 2–6 строк: что хочет ученик, зачем, пример" })),
		}),
		...quietRender(
			(a) => (a?.action === "send" ? "Отправляю заявку автору…" : a?.action === "cancel" ? "Отменяю заявку…" : "Готовлю заявку для ученика…"),
			(r) => String(r?.details?.summary ?? "готово"),
		),
		async execute(_id, p: { action: string; text?: string }, _s, _u, ctx) {
			const gate = gateFor(ctx.cwd);
			if (p.action === "draft") {
				const t = String(p.text ?? "").trim();
				if (t.length < proto.minTextChars) throw new Error(`текст заявки короткий (меньше ${proto.minTextChars} знаков): опиши, что нужно и зачем`);
				if (t.length > proto.maxTextChars) throw new Error(`текст заявки длиннее ${proto.maxTextChars} знаков: сократи`);
				gate.setDraft(t);
				return text(`Черновик готов. Покажи ученику ДОСЛОВНО этот текст и спроси, отправить ли Максу. Жди его «да»; без «да» ничего не отправляй.\n\n${t}`, { summary: "черновик показан ученику, жду «да»" });
			}
			if (p.action === "cancel") {
				gate.cancel();
				return text("Черновик выброшен.", { summary: "отменено" });
			}
			if (p.action === "send") {
				const a = gate.approve();
				if (!a.ok) throw new Error(`не отправил: ${a.reason}`);
				const r = await submitWish(ctx.cwd, a.text, post());
				gate.cancel();
				if (r.sent) return text(`Отправил Максу (заявка ${r.id}). Копия в learner/wishes.md. Скажи ученику одной фразой, что передал.`, { summary: "отправлено автору", ...r });
				return text(`Сети или сервера сейчас нет (${r.error}). Заявка сохранена в ${wishesFile(ctx.cwd)} и уйдёт при ближайшем запуске агента с сетью (не чаще раза в сутки). Скажи ученику это одной фразой.`, { summary: "сохранено, уйдёт позже", ...r });
			}
			throw new Error("action: draft, send или cancel");
		},
	});
}
