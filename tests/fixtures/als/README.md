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

Сеты, собранные самим автором в Live 12 (аккорды + бас + мелодия в Session; «оркестровая» аранжировка с
локаторами и автоматизацией громкости), сюда добавятся, когда будет доступна виртуальная машина с Live.
Пока этих сценариев нет в реальных файлах, их покрывает синтетический `.als` из `tests/alsbuild.ts`
(собирается в тесте, в Live не открывался).
