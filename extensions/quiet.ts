/**
 * Тихий экран ученика: встроенные инструменты pi одной строкой, свой футер вместо служебного.
 *
 * Встроенные read/write/edit/bash/ls/grep/find/powershell регистрируются так же, как у pi, — меняются
 * только рендеры (`pi.registerToolRenderer`, см. docs/extensions.md «Custom Rendering»). Исполнение,
 * подсказки и имена полей не трогаются, поэтому роль и скилл работают как раньше.
 *
 * Футер заменяется на короткий: «Агент · Ctrl+O — подробности» и предупреждения расширений
 * (`ctx.ui.setStatus`). Токены, кеш, деньги и модель ученику не нужны — баланс ключа и так
 * показывается в сводке на старте сессии (T1906).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { BUILTIN_TOOLS, builtinCall, builtinSummary, callRow, partialRow, resultRow } from "../lib/mm/quiet.ts";

/** Текст футера: коротко, без служебных цифр. */
export const FOOTER_TITLE = "Агент";
export const FOOTER_HINT = "Ctrl+O — подробности";

/**
 * Поставить короткий футер. Отдельной функцией: тест зовёт её с поддельным ctx, pi не нужен.
 */
export function installFooter(ctx: any): boolean {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function") return false;
	ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
		const unsubscribe = typeof footerData?.onBranchChange === "function" ? footerData.onBranchChange(() => tui.requestRender?.()) : undefined;
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const statuses = [...(footerData?.getExtensionStatuses?.()?.values?.() ?? [])].filter((s: unknown) => typeof s === "string" && s.trim());
				const line = [FOOTER_TITLE, FOOTER_HINT, ...statuses].join(" · ");
				return [truncateToWidth(theme.fg("dim", line), width)];
			},
		};
	});
	return true;
}

/** Рендеры спокойного экрана для расширения-обёртки: раскрытый вид — как у pi, если он есть. */
function quietBase(base: any, toolName: string) {
	const baseResult = base?.renderResult;
	return {
		renderCall(args: any, theme: any) {
			return callRow(builtinCall(toolName, args), theme);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (options?.isPartial) return partialRow(theme);
			if (options?.expanded && typeof baseResult === "function") {
				try {
					return baseResult(result, options, theme, context);
				} catch {
					// Рендер pi не сработал (бывает на экзотических результатах) — покажем текст сами.
				}
			}
			return resultRow(result, builtinSummary(toolName, result, context?.args), { ...options, isError: context?.isError, keyHint: context?.keyHint }, theme);
		},
	};
}

/**
 * Убрать подпись у свёрнутых блоков мыслей: pi пишет там «Thinking…», а ученику нужен ответ.
 * С пустой подписью строка не рисуется вовсе (проверено в изоляции 2026-11-26).
 */
export function hideThinkingLabel(ctx: any): boolean {
	if (!ctx?.hasUI || typeof ctx.ui?.setHiddenThinkingLabel !== "function") return false;
	ctx.ui.setHiddenThinkingLabel("");
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		if (!(BUILTIN_TOOLS as readonly string[]).includes(toolName)) return next();
		return quietBase(next(), toolName);
	});

	pi.on("session_start", (_event, ctx) => {
		installFooter(ctx);
		hideThinkingLabel(ctx);
	});
}
