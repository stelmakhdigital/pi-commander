# commander

pi-пакет: связывает **зарегистрированные долгоживущие pi-агенты** (каждый — своя pi-сессия в tmux-пане) в рабочую цепочку **worker → planner → judge** с loop'ом по вердикту судьи.

## Модель

- **Агенты** — твои живые pi-сессии в tmux-панях. Регистрация: имя + пань + роль.
- **Conductor** — это расширение в твоей основной pi-сессии. Детерминированный TS state machine, без LLM. Общается с агентами через `send-keys`: одна строка-указатель на brief-файл (многострочный ввод ломал бы TUI).
- **Сигнал готовности** этапа = done-файл на диске (часть протокола, а не транспорта) + валидный артефакт.
- **Артефакты и контракты** — `.pi/pipeline/PROTOCOL.md` (пишется автоматически при первом запуске, bootstrap'ится в агентов при регистрации).

```
Ты ── pipeline_run(spec) ──► CONDUCTOR (extension, state machine)
                               │ round N: worker → planner → judge
   tmux pane %12 ◄─send-keys──┤    (каждый: brief-файл → артефакт → done-файл)
   tmux pane %7  ◄────────────┘    pass → готово
   tmux pane %15 ◄───────────────── revise → round N+1 | blocked / max_rounds / cycle → эскалация тебе
```

## Install

`~/.pi/agent/settings.json` → `packages`:

```json
{ "source": "file:/home/arkalaust/Code/AGENTS/commander" }
```

(для git-установки: `git push` + `"git:github.com/<you>/commander"`)

## Usage

1. Запусти пи-агентов в tmux-панях (любые, с нужными tools/model).
2. В основной сессии: «Зарегистрируй пань %12 как worker, %7 как planner, %15 как judge» → `pipeline_register` ×3 (bootstrap сам улетит в пани).
3. Напиши `spec.md` — шаблон в `PROTOCOL.md §spec`; **обязателен раздел «Критерии приёмки»** (судья сверяет только по нему).
4. «Запусти pipeline по spec.md» → `pipeline_run`. Цикл идёт фоном, результат придёт сообщением `[commander] T-...: PASS/ESCALATION`.
5. `pipeline_status` — прогресс, `pipeline_abort` — стоп, `pipeline_send` — ручная строка агенту (отладка).

## Инструменты

| Tool | Зачем |
|---|---|
| `pipeline_run` | запуск: spec → цикл worker→planner→judge |
| `pipeline_status` | стадия, раунд, история вердиктов, артефакты |
| `pipeline_register` | пань + роль в реестр + bootstrap |
| `pipeline_agents` | реестр + живость пней |
| `pipeline_send` | одна строка агенту (ad-hoc/отладка) |
| `pipeline_abort` | остановить цикл |

## Loop и guardrails

`round: worker → planner → judge → pass | revise (round N+1) | blocked (к тебе)`.
Эскалация: `max_rounds` (default 3), **cycle-detect** (findings двух раундов >50% совпадают → прогресса нет), мёртвая пань, таймаут этапа (45 мин), невалидный verdict судьи после повторного запроса.

## Layout

`.pi/pipeline/` — `registry.json`, `PROTOCOL.md`, `<T-id>/{spec.md, state.json, round-N/{brief-*, *report/decision/verdict, done-*}}`.

## Selfcheck

`node --experimental-strip-types test/selfcheck.ts` (cycle-detect, verdict-парсинг, brief'ы).

## Ограничения (v1)

- Одна задача за раз (lock по активному state).
- Одна роль — один агент.
- tmux-транспорт (agent и conductor в одном tmux-сервере).
- Вопрос worker→planner — end-of-round (секция «Открытые вопросы»), не mid-round.
