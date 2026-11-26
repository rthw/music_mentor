/**
 * Агент растёт: рецепты ученика и песочница своих функций.
 *
 * recipe_save     — записать приём или упражнение этого ученика маленьким скиллом в learner/recipes;
 * my_tools_save   — записать расширение в learner/my_tools и проверить отдельным pi, что оно грузится
 *                   (не грузится — файл откатывается); писать только по просьбе ученика;
 * my_tools_admin  — список функций, проверка, «выключи мои функции», «включи», «убери функцию».
 *
 * Логика — lib/mm/recipes.ts и lib/mm/mytools.ts (tests/grow.test.ts); здесь только инструменты.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { disabledReason, ensurePackage, listTools, myToolsDir, probePi, removeTool, saveTool, setMyTools, type ProbeResult } from "../lib/mm/mytools.ts";
import { quietRender } from "../lib/mm/quiet.ts";
import { saveRecipe } from "../lib/mm/recipes.ts";

export interface GrowDeps {
	/** Подмена проверки pi: в тестах без настоящего pi. */
	probe?: (extra: string[]) => Promise<ProbeResult>;
	/** Подмена settings.json и окружения. */
	env?: NodeJS.ProcessEnv;
}

function text(t: string, details: object = {}) {
	return { content: [{ type: "text" as const, text: t }], details };
}

export default function (pi: ExtensionAPI, deps: GrowDeps = {}) {
	const probeFor = (cwd: string) => deps.probe ?? ((extra: string[]) => probePi({ cwd, env: deps.env, extraExtensions: extra }));

	// «Мои функции выключены» (аварийный выключатель сработал или ученик попросил): один раз за сессию —
	// строка в окне и скрытая заметка в первый ход, чтобы агент предложил починить.
	let told = false;
	pi.on("session_start", (_e: any, ctx: any) => {
		if (!disabledReason(myToolsDir(ctx.cwd))) return;
		try {
			ctx.ui?.notify?.("Мои функции выключены — скажи агенту «почини мои функции».", "warning");
		} catch {
			// нет окна — не беда
		}
	});
	pi.on("before_agent_start", (event: any, ctx: any) => {
		if (told || event?.messageType !== "user") return;
		told = true;
		const why = disabledReason(myToolsDir(ctx.cwd));
		if (!why) return;
		return { message: { customType: "mentor-my-tools-off", content: `Свои функции ученика сейчас выключены: ${why}. Если он не просил их выключить — одной строкой предложи починить (my_tools_admin: list, check; правка файла через my_tools_save), а не молчи.`, display: false } };
	});

	pi.registerTool({
		name: "recipe_save",
		label: "Рецепт для ученика",
		description:
			"Записать рецепт — маленький скилл с приёмом или упражнением, которое сработало именно у этого ученика (или он сказал «запомни»). Пиши коротко и без дублей: прежде чем записывать, посмотри свои скиллы; похожий рецепт обнови (name того же рецепта, overwrite=true), а не заводи второй. Рецепт появится в списке скиллов со следующего запуска агента. Не пиши в рецепт личное (имена, пути к проектам, пароли) и не записывай по пустяку: только то, что пригодится в другой раз.",
		promptSnippet: "Записать рецепт (приём или упражнение ученика) в learner/recipes",
		parameters: Type.Object({
			name: Type.String({ description: "Короткое имя латиницей через дефис, например sidechain-kick-chill" }),
			description: Type.String({ description: "Одна фраза: что это и когда открывать (20–300 знаков)" }),
			body: Type.String({ description: "Сам рецепт markdown-ом: шаги в Live, на что смотреть, почему сработало. До 4000 знаков" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Заменить существующий рецепт с этим именем" })),
		}),
		...quietRender(
			(a) => `Записываю рецепт «${a?.name ?? "…"}»…`,
			(r) => (r?.details?.status === "created" || r?.details?.status === "updated" ? `рецепт ${r.details.name} сохранён` : "рецепт не записан"),
		),
		async execute(_id, p: { name: string; description: string; body: string; overwrite?: boolean }, _s, _u, ctx) {
			const r = saveRecipe(ctx.cwd, p);
			const ok = r.status === "created" || r.status === "updated";
			const note = ok ? ". Появится в списке скиллов со следующего запуска; ученику скажи одной фразой, что запомнил." : "";
			if (!ok) throw new Error(r.message);
			return text(r.message + note, { ...r });
		},
	});

	pi.registerTool({
		name: "my_tools_save",
		label: "Своя функция агента",
		description:
			"Записать новую функцию-расширение pi в песочницу learner/my_tools и проверить, что она загружается. Только по просьбе ученика: сначала скажи ему простыми словами, что допишешь себе новую функцию, и только потом вызывай. Файл — полный TypeScript-модуль `export default function (pi: ExtensionAPI) { pi.registerTool({...}) }`, маленький, без сети, без записи вне learner, импорты только `@earendil-works/pi-coding-agent` (типы) и `typebox`. Не загрузился — файл откатывается и ты получаешь ошибку pi: поправь и запиши снова.",
		promptSnippet: "Записать свою функцию (расширение pi) в learner/my_tools с проверкой загрузки",
		parameters: Type.Object({
			name: Type.String({ description: "Имя файла без расширения: строчная латиница, цифры, _ (track_minutes)" }),
			code: Type.String({ description: "Весь файл расширения" }),
		}),
		...quietRender(
			(a) => `Дописываю функцию «${a?.name ?? "…"}» и проверяю, что она загружается…`,
			(r) => (r?.details?.ok ? "функция записана и загружается" : "не загрузилась, файл откатил"),
		),
		async execute(_id, p: { name: string; code: string }, _s, _u, ctx) {
			const dir = myToolsDir(ctx.cwd);
			const r = await saveTool(dir, p.name, p.code, probeFor(ctx.cwd));
			if (!r.ok) throw new Error(r.message);
			const off = disabledReason(dir);
			const tail = off
				? " Но «мои функции» сейчас выключены (" + off + "): включи их через my_tools_admin(action=on), когда файлы исправны."
				: " В этой сессии функция ещё не видна: она заработает после перезапуска агента (скажи ученику закрыть окно и открыть снова).";
			return text(r.message + "." + tail, { ...r });
		},
	});

	pi.registerTool({
		name: "my_tools_admin",
		label: "Мои функции агента",
		description:
			"Управление своими функциями: action=list (что записано и включены ли), check (проверить отдельным pi, что всё грузится), off («выключи мои функции» — пакет убирается из настроек до включения), on (включить обратно, с проверкой; не грузится — снова выключит), remove (убрать функцию name, копия остаётся с суффиксом .removed). Фраза ученика «почини мои функции» — это list, затем check и правка файла через my_tools_save.",
		promptSnippet: "Мои функции: список, проверка, выключить/включить, убрать",
		parameters: Type.Object({
			action: Type.String({ description: "list | check | off | on | remove" }),
			name: Type.Optional(Type.String({ description: "для remove: имя функции без .ts" })),
		}),
		...quietRender(
			(a) => `Мои функции: ${a?.action ?? ""}…`,
			(r) => String(r?.details?.summary ?? "готово"),
		),
		async execute(_id, p: { action: string; name?: string }, _s, _u, ctx) {
			const dir = myToolsDir(ctx.cwd);
			ensurePackage(dir);
			const tools = listTools(dir);
			const off = disabledReason(dir);
			const state = off ? `выключены (${off})` : "включены";
			if (p.action === "list") {
				const body = tools.length ? tools.map((t) => `- ${t}`).join("\n") : "пока ничего не записано";
				return text(`Мои функции ${state}.\n${body}`, { summary: `${tools.length} функций, ${off ? "выключены" : "включены"}`, tools, off });
			}
			if (p.action === "check") {
				const r = await probeFor(ctx.cwd)(off ? tools.map((t) => `${dir}/extensions/${t}`) : []);
				return text(r.ok ? "Всё загружается." : `Не загружается:\n${r.output || "pi не ответил"}`, { summary: r.ok ? "всё грузится" : "есть поломка", ok: r.ok });
			}
			if (p.action === "off") {
				setMyTools(dir, false, "выключено по просьбе ученика", deps.env);
				return text("Мои функции выключены: со следующего запуска агент стартует без них. Включить обратно — my_tools_admin(action=on).", { summary: "выключены", ok: true });
			}
			if (p.action === "on") {
				setMyTools(dir, true, "", deps.env);
				const r = await probeFor(ctx.cwd)([]);
				if (!r.ok) {
					setMyTools(dir, false, `не загрузились при включении: ${r.output.split("\n")[0] ?? ""}`, deps.env);
					throw new Error(`не включил: при проверке pi сказал\n${r.output || "нет ответа"}\nФункции остались выключенными; поправь файл через my_tools_save.`);
				}
				return text("Мои функции включены (со следующего запуска).", { summary: "включены", ok: true });
			}
			if (p.action === "remove") {
				if (!p.name || !removeTool(dir, p.name.replace(/\.ts$/, ""))) throw new Error(`нет функции ${p.name ?? ""}`);
				return text(`Убрал ${p.name}: копия лежит рядом с суффиксом .removed.`, { summary: `убрал ${p.name}` });
			}
			throw new Error("action: list, check, off, on или remove");
		},
	});
}
