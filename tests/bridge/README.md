# Тесты моста MentorBridge

`test_mentor_bridge.py` — один файл `unittest`, работает под Python 2.7 (Live 10) и 3.x (Live 11/12) без зависимостей.
Объектная модель Live заменена фейком (`fake_lom.py`) в двух профилях: «Live 11+» (`add_new_notes` / `get_notes_extended`)
и «Live 10» (только `set_notes` / `get_notes`). Покрыто: протокол, чтение, добавление, каждый отказ запрета
(проверяется, что проект ученика не изменился), занятый слот, лимит треков, сокет-сервер (LOM только в потоке `poll`).

`npm test` запускает файл под обоими интерпретаторами (`tests/bridge.test.ts`). Python 2.7 ищется так:
`MM_PYTHON2`, затем `python2.7`, `python2`, затем `mise exec conda:python@2.7 -- python`. Ставить:

```sh
mise exec conda:python@2.7 -- python --version   # скачает Python 2.7 из conda (5 секунд), без root
```

Если Python 2.7 не найден, тест пропускается с пояснением (не падает), но релиз без прогона под 2.7 не считается проверенным.
Вручную: `python3 tests/bridge/test_mentor_bridge.py` и `mise exec conda:python@2.7 -- python tests/bridge/test_mentor_bridge.py`.
