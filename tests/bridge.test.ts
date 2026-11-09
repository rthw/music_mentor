import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const FILE = path.join(import.meta.dirname, "bridge", "test_mentor_bridge.py");
const ROOT = path.join(import.meta.dirname, "..");

/** Интерпретатор: [команда, ...аргументы]. Python 2.7 ищем: MM_PYTHON2, python2.7, python2, mise (conda:python@2.7). */
function find(version: 2 | 3): string[] | undefined {
	const candidates: string[][] =
		version === 3
			? [process.env.MM_PYTHON3 ? [process.env.MM_PYTHON3] : [], ["python3"], ["python"]].filter((c) => c.length)
			: [process.env.MM_PYTHON2 ? [process.env.MM_PYTHON2] : [], ["python2.7"], ["python2"], ["mise", "exec", "conda:python@2.7", "--", "python"]].filter((c) => c.length);
	for (const c of candidates) {
		const r = spawnSync(c[0], [...c.slice(1), "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 120_000 });
		if (r.status === 0 && r.stdout.trim() === String(version)) return c;
	}
	return undefined;
}

for (const v of [2, 3] as const) {
	const py = find(v);
	test(`мост MentorBridge на фейковом LOM под Python ${v}`, { skip: py ? false : `Python ${v} не найден (см. tests/bridge/README.md)` }, () => {
		const r = spawnSync(py![0], [...py!.slice(1), FILE], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
		const out = (r.stdout ?? "") + (r.stderr ?? "");
		assert.equal(r.status, 0, out);
		assert.match(out, /\nOK\b/);
		const ran = /Ran (\d+) tests/.exec(out);
		assert.ok(ran && Number(ran[1]) >= 30, out);
	});
}
