/**
 * Подмена пакетов pi в тестах. typebox и @earendil-works/pi-tui ставит сам pi, в репозитории их нет;
 * расширения и `lib/mm/quiet.ts` их импортируют, поэтому до первого импорта расширений подсовываем
 * заглушки из tests/stubs/. Достаточно импортировать этот файл первой строкой теста.
 */

import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "typebox") return { url: new URL("./typebox.ts", import.meta.url).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: new URL("./tui.ts", import.meta.url).href, shortCircuit: true };
		return next(specifier, context);
	},
});
