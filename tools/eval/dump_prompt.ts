/**
 * Проверка «скилл виден pi»: пишет системный промпт сессии в файл, чтобы убедиться, что `mentor`
 * попал в блок `<available_skills>`. Запускается только из `tools/eval/run.sh` через `-e`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const out = process.env.MM_EVAL_PROMPT_DUMP;
		if (out) writeFileSync(out, event.systemPrompt);
	});
}
