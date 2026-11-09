# Фикстуры .als

Файлы для тестов чтения проектов (`extensions/als.ts`, `lib/als`). Все файлы — настоящие проекты Ableton Live
в исходном виде (gzip XML), версия Live — в заголовке `Creator`. Ожидаемые значения (темп, треки, устройства,
клипы, ноты) записаны в `tests/als.test.ts` и сверены с независимым разбором XML.

Чужие файлы лежат здесь на условиях лицензий их репозиториев; тексты лицензий — в `licenses/`.

## Live 10

| Файл | Версия | Источник | Лицензия |
|---|---|---|---|
| `10/abletoolz_10_1_18.als` | 10.1.18 | github.com/elixirbeats/abletoolz, `test/version_fixtures/skeletons/10.1.18.als`, коммит 69b1ae1 | MPL-2.0 |
| `10/abletoolz_10_0_6.als` | 10.0.6 | то же, `skeletons/10.0.6.als` | MPL-2.0 |

## Live 11

| Файл | Версия | Источник | Лицензия |
|---|---|---|---|
| `11/abletoolz_11_0_0.als` | 11.0 | github.com/elixirbeats/abletoolz, `skeletons/11.0.0.als` | MPL-2.0 |
| `11/maxdevtools_test.als` | 11.3.13 | github.com/Ableton/maxdevtools, `maxdiff/tests/test_files/Test Project/Test.als`, коммит 5b39dec; в источнике несжатый XML, здесь только сжат gzip | MIT |

## Live 12

| Файл | Версия | Источник | Лицензия |
|---|---|---|---|
| `12/alsparse_midi.als` | 12.0.25 | github.com/Coestaris/alsparse, `tests/als/midi.als`, коммит 92b68a1 (барабанный клип, 331 нота) | MIT |
| `12/live2midi_test.als` | 12.4.16 | github.com/nwhetsell/live2midi, `test_live2midi.als.xml`, коммит 8c7ea6c; сжат gzip (петли, выключенные ноты) | MIT |
| `12/groovebox_template_v12.als` | 12.2 | github.com/sheaivey/GrooveboxToAbleton, `examples/als/Template_v12.als.xml`, коммит a3d919a; сжат gzip (аудио-треки, без клипов) | MIT |

### Сеты из виртуальной машины (Live 12.4.15–12.4.16, собраны через `win_live`/AgentBridge)

Оба файла собраны 2026-11-09 в Live 12 Suite в VM автора; звук не включался. В VM лежат в
`C:\Users\max\Documents\agent_sets\2026-11-09_<имя>\<имя> Project\`. Ноты, имена и инструменты заданы
командами моста; трек-лист — стандартный (после «Ctrl+N» в Live два пустых аудио-трека и возвраты A/B).

| Файл | Что внутри |
|---|---|
| `12/vm_session_chords.als` | 100 BPM. Session: Chords (Wavetable) — 2 клипа «Chords», «Chords 2»; Bass (Operator); Melody (Drift). Прогрессия C–G–Am–F, 4 такта; 3 трека и 2 сцены, 56 нот |
| `12/vm_orchestral.als` | 84 BPM, 24 такта. Arrangement: Strings (Wavetable) — 3 клипа; Pad (Drift); Bass (Operator); Perc (Drum Rack). Локаторы Intro (т1), Theme (т9), Climax (т17). Тональность C мажор, секция Climax — D мажор. Автоматизация громкости на Strings (дорожка автоматизации Arrangement; в Session-клипах те же огибающие как `ClipEnvelope`). Те же клипы лежат и в Session |

Расширения моста для этих сетов (`set_track_name`, `set_tempo`, `set_time`+`add_locator`, `clip_envelope`) добавлены в
`agent_tools/win_live/remote_script/AgentBridge/commands.py`.
