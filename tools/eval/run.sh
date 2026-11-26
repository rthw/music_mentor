#!/usr/bin/env bash
# Поведение наставника: 5 сценариев через `pi -p` на фикстурах (spec §7).
#
# Изоляция обязательна: на машине автора pi подхватывает чужие скиллы (~/.agents/skills, пакеты),
# поэтому у прогона свои HOME и PI_CODING_AGENT_DIR, а рабочая папка — копия template/.
#
# Запуск (ключ берётся из хранилища и передаётся только в окружение процесса):
#   secret run DEEPSEEK_API_KEY -- tools/eval/run.sh            # все 7
#   secret run DEEPSEEK_API_KEY -- tools/eval/run.sh 01 03      # только выбранные
#
# Ответы: ~/.local/state/music_mentor/eval/runs/<дата_время>/*.md (или OUT=<папка>).
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODEL="${MM_EVAL_MODEL:-deepseek-v4-pro}"
# Ответы — вне репозитория: в них пути машины, а тест «нет путей автора» ходит по всему дереву.
OUT="${OUT:-${XDG_STATE_HOME:-$HOME/.local/state}/music_mentor/eval/runs/$(date +%Y-%m-%d_%H%M)}"
TIMEOUT="${MM_EVAL_TIMEOUT:-600}"

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
	echo "Нет DEEPSEEK_API_KEY в окружении. Запускай так:" >&2
	echo "  secret run DEEPSEEK_API_KEY -- tools/eval/run.sh" >&2
	exit 2
fi

PI="$(command -v pi || true)"
# В PATH «secret run» первым стоит shim mise: readlink уводит в сам mise. Спрашиваем mise, где
# лежит настоящий бинарник, — иначе запускать будем mise с чужими флагами.
if [ -n "$PI" ]; then
	real_pi="$(mise which pi 2>/dev/null || true)"
	PI="${real_pi:-$(readlink -f "$PI")}"
fi
if [ -z "$PI" ]; then
	echo "pi не найден в PATH." >&2
	exit 2
fi

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/mm_eval.XXXXXX")"
BRIDGE_PID=""
cleanup() {
	[ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null
	rm -rf "$WORKROOT"
}
trap cleanup EXIT

AGENT_DIR="$WORKROOT/agent"
mkdir -p "$AGENT_DIR" "$OUT"
# Ключ — только в auth.json временного каталога pi; после прогона файл уходит вместе с WORKROOT.
umask 077
printf '{"deepseek":{"type":"api_key","key":"%s"}}\n' "$DEEPSEEK_API_KEY" >"$AGENT_DIR/auth.json"

# Настройки как у установщика (Set-PiSettings в lib/win/common.ps1) + сам пакет.
cat >"$AGENT_DIR/settings.json" <<JSON
{
  "defaultProvider": "deepseek",
  "defaultModel": "$MODEL",
  "quietStartup": true,
  "enabledModels": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"],
  "packages": ["$REPO"]
}
JSON

# Проекты ученика: пара .als в «Документах» временного HOME, иначе briefing и project_list пусты.
PROJECTS="$WORKROOT/home/Documents/Проекты"
mkdir -p "$PROJECTS"
cp "$REPO/tests/fixtures/als/12/vm_session_chords.als" "$PROJECTS/Ночь.als"
cp "$REPO/tests/fixtures/als/12/vm_orchestral.als" "$PROJECTS/Оркестр.als"
touch -d "2026-11-25 20:00" "$PROJECTS/Ночь.als"
touch -d "2026-11-20 19:00" "$PROJECTS/Оркестр.als"

# Рабочая папка: копия template/. Для сценариев 2–5 — «вторая сессия» с профилем и журналом,
# для 06 — профиль ученика, который хочет играть руками (instrument / wants_to_learn).
make_workspace() { # $1 = first|second|play, $2 = куда
	local kind="$1" dest="$2" src="second_session"
	cp -r "$REPO/template" "$dest"
	[ "$kind" = "play" ] && src="play"
	[ "$kind" = "ear" ] && src="ear"
	if [ "$kind" != "first" ]; then
		cp "$REPO/tools/eval/fixtures/$src/profile.md" "$dest/learner/profile.md"
		cp "$REPO/tools/eval/fixtures/$src/log.jsonl" "$dest/learner/log.jsonl"
	fi
}

# «Запись» ученика для сценария 06: .als с его попыткой сыграть бас «Ночи» (ноты с ошибками,
# сборка — tools/eval/fixtures/play/build_recording.ts). Без Live мост недоступен, поэтому
# сыгранное берётся из проекта — так же, как это делает play_check с played_path.
build_recording() { # $1 = папка проектов
	local file="$1/Ночь — запись.als"
	[ -f "$file" ] && return
	if ! node "$REPO/tools/eval/fixtures/play/build_recording.ts" "$file"; then
		echo "   не собрал «запись» для 06 — см. вывод выше" >&2
	fi
}

run_one() { # $1 = файл сценария, $2 = first|second|play|ear
	local scenario="$1" kind="$2" name ws log dir turn prompt code=0 turns=0 one=0 bridge_pid=""
	# Сценарию со слухом нужен мост: настоящего Live в прогоне нет, поэтому поднимаем заглушку
	# с тем же протоколом (tools/eval/fixtures/ear/fake_bridge.ts) и гасим её по своему PID.
	if [ "$kind" = "ear" ]; then
		node "$REPO/tools/eval/fixtures/ear/fake_bridge.ts" >"$WORKROOT/fake_bridge.log" 2>&1 &
		bridge_pid=$!
		BRIDGE_PID=$bridge_pid
		sleep 0.5
		if ! kill -0 "$bridge_pid" 2>/dev/null; then
			echo "   заглушка моста не поднялась — см. $WORKROOT/fake_bridge.log" >&2
		fi
	fi
	name="$(basename "$scenario" .txt)"
	ws="$WORKROOT/work-$name"
	dir="$WORKROOT/turns-$name"
	make_workspace "$kind" "$ws"
	log="$OUT/$name.md"
	[ "$kind" = "play" ] && build_recording "$PROJECTS"
	mkdir -p "$dir"
	# Ходы разделены строкой «--- ход ---»: обычный сценарий — один ход. Между ходами
	# сохраняется сессия pi (--session-id), поэтому второй ход — продолжение того же урока.
	awk -v d="$dir" 'BEGIN { n = 1; f = sprintf("%s/%02d.txt", d, n) } /^--- ход ---$/ { n++; f = sprintf("%s/%02d.txt", d, n); next } { print > f }' "$scenario"
	: >"$log"
	for turn in "$dir"/*.txt; do
		prompt="$(cat "$turn")"
		turns=$((turns + 1))
		echo "== $name ($kind), ход $turns: $prompt"
		if [ "$turns" -gt 1 ]; then
			{ echo; echo "### Ход $turns"; echo; echo "> $prompt"; echo; } >>"$log"
		fi
		(
			cd "$ws" || exit 1
			HOME="$WORKROOT/home" \
			PI_CODING_AGENT_DIR="$AGENT_DIR" \
			PI_SKIP_VERSION_CHECK=1 \
			PI_TELEMETRY=0 \
			MM_ROOT="$WORKROOT/mm-root-$name" \
			MM_LIVE_HOST=127.0.0.1 \
			MM_LIVE_PORT=9878 \
			timeout "$TIMEOUT" "$PI" -p --session-id "mm-eval-$name" "$prompt"
		) >>"$log" 2>&1
		one=$?
		if [ $one -ne 0 ]; then
			code=$one
			echo "   ход $turns: код $one — см. $log"
		else
			echo "   ход $turns: ок → $log"
		fi
	done
	[ -n "$bridge_pid" ] && kill "$bridge_pid" 2>/dev/null
	{
		echo
		echo "---"
		echo "сценарий: $name"
		echo "режим: $kind"
		echo "модель: $MODEL"
		echo "ходов: $turns"
		echo "код: $code"
	} >>"$log"
}

echo "Репозиторий: $REPO"
echo "Модель: $MODEL"
echo "Ответы: $OUT"
echo "Изоляция: HOME=$WORKROOT/home PI_CODING_AGENT_DIR=$AGENT_DIR"

# Скилл виден pi только если разобрался фронтматтер (см. tests/skills.test.ts). Проверяем это
# механически: дампим системный промпт сессии и ищем там блок <available_skills>.
SKILL_CHECK="$OUT/00-skill-check.txt"
mkdir -p "$WORKROOT/skillcheck"
(
	cd "$WORKROOT/skillcheck" || exit 1
	HOME="$WORKROOT/home" \
	PI_CODING_AGENT_DIR="$AGENT_DIR" \
	PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
	MM_EVAL_PROMPT_DUMP="$WORKROOT/prompt.txt" \
	MM_ROOT="$WORKROOT/mm-root-skillcheck" \
	timeout "$TIMEOUT" "$PI" -p --no-session -e "$REPO/tools/eval/dump_prompt.ts" "ок" >/dev/null 2>&1
) || echo "   pi не отработал для проверки скилла"
{
	echo "# Виден ли скилл mentor в сессии pi (блок <available_skills> системного промпта)"
	grep -A 4 '<available_skills>' "$WORKROOT/prompt.txt" 2>/dev/null | head -40
} >"$SKILL_CHECK"
if grep -q '<name>mentor</name>' "$SKILL_CHECK"; then
	echo "скилл mentor виден pi: да"
else
	echo "скилл mentor виден pi: НЕТ — см. $SKILL_CHECK"
fi

want=("$@")
run() { # $1 = файл, $2 = режим
	if [ ${#want[@]} -gt 0 ]; then
		local id
		id="$(basename "$1" | cut -d- -f1)"
		for w in "${want[@]}"; do [ "$w" = "$id" ] && run_one "$1" "$2" && return; done
		return
	fi
	run_one "$1" "$2"
}

run "$REPO/tools/eval/scenarios/01-first.txt" first
run "$REPO/tools/eval/scenarios/02-track.txt" second
run "$REPO/tools/eval/scenarios/03-sidechain.txt" second
run "$REPO/tools/eval/scenarios/04-chill.txt" second
run "$REPO/tools/eval/scenarios/05-bass.txt" second
run "$REPO/tools/eval/scenarios/06-play.txt" play
run "$REPO/tools/eval/scenarios/07-ear.txt" ear

echo "Готово: $OUT"
