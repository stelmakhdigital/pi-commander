# commander

pi-пакет: связывает **зарегистрированные долгоживущие pi-агенты** в рабочую цепочку **worker → planner → judge** с loop'ом по вердикту судьи.

## Модель

- **Агенты** — живые pi-сессии, два транспорта:
  - `tmux` — твоя уже запущенная pi-сессия в tmux-пане (conductor пишет `send-keys`);
  - `rpc` — `pi --mode rpc`, дочерний процесс, поднятый conductor'ом (JSONL-протокол).
- **Conductor** — это расширение в твоей основной pi-сессии. Детерминированный TS state machine, без LLM. Для tmux — одна строка-указатель на brief-файл (многострочный ввод ломал бы TUI); для RPC — prompt по JSONL.
- **Сигнал готовности** этапа = done-файл на диске (часть протокола, а не транспорта) + валидный артефакт.
- **Mid-round Q&A**: worker застрял без решения архитектора → `round-N/ask-worker.md` → conductor ретранслирует planner'у → `answers-<k>.md` → worker продолжает. Лимит 3 Q&A/этап (против зацикливания).
- **Параллельные задачи**: у каждой задачи свой набор агентов (`agents={worker, planner, judge}`), конфликт-чек по занятым агентам. Параллельные задачи в одном репо — на совести пользователя (git worktree / отдельные каталоги; judge оценивает `git diff` в своём cwd).
- **Артефакты и контракты** — `.pi/pipeline/PROTOCOL.md` (пишется автоматически, bootstrap'ится в агентов при регистрации).

```
Ты ── pipeline_run(spec, agents?) ──► CONDUCTOR (extension, state machine)
                                        │ round N: worker → planner → judge
   tmux pane %12 ◄─send-keys───────────┤    (каждый: brief → артефакт → done-файл)
   rpc proc (pi --mode rpc) ◄─JSONL────┤    (worker может mid-round спросить planner'а)
   tmux pane %7  ◄──────────────────────┘    pass → готово
                                             revise → round N+1 | blocked / max_rounds / cycle / Q&A-loop → эскалация
```

## Install

`~/.pi/agent/settings.json` → `packages`:

```json
{ "source": "git:github.com:stelmakhdigital/pi-commander.git" }
```

(локально: `{ "source": "file:/path/to/commander" }`)

## Usage

1. Агенты в tmux-панях — или вообще без пней: conductor сам поднимет RPC-процессы.
2. В основной сессии: «Зарегистрируй %12 как worker, %7 как planner, %15 как judge» → `pipeline_register` ×3. Для RPC: `pipeline_register name=architect role=planner kind=rpc [model=...]`.
3. Напиши `spec.md` — шаблон в `PROTOCOL.md §spec`; **обязателен раздел «Критерии приёмки»**.
4. «Запусти pipeline по spec.md» → `pipeline_run`. Цикл в фоне, результат — сообщением `[commander] T-...: PASS/ESCALATION`.
5. `pipeline_status` — прогресс (все активные), `pipeline_abort [id]` — стоп, `pipeline_send` — ручное сообщение агенту, `pipeline_agents` — реестр + занятость.

Параллельно: `pipeline_run(spec=A, agents={worker: w1, planner: p1, judge: j1})` + `pipeline_run(spec=B, agents={...другой набор...})`.

## Инструменты

| Tool | Зачем |
|---|---|
| `pipeline_run` | запуск: spec (+ явный набор агентов) → цикл worker→planner→judge |
| `pipeline_status` | активные задачи: стадия, раунд, история вердиктов, артефакты |
| `pipeline_register` | агент (tmux-пань или RPC) + роль в реестр + bootstrap |
| `pipeline_agents` | реестр + живость + занятость в задачах |
| `pipeline_send` | сообщение агенту (ad-hoc/отладка) |
| `pipeline_abort` | остановить задачу (id) или все активные |

## Loop и guardrails

`round: worker → planner → judge → pass | revise (round N+1) | blocked (к тебе)`.
Эскалация: `max_rounds` (default 3), **cycle-detect** (findings двух раундов >50% совпадают), Q&A-loop (>3 вопросов за этап), Q&A-таймаут (15 мин), таймаут этапа (45 мин), мёртвый агент, невалидный verdict судьи после повторного запроса.

## Layout

`.pi/pipeline/` — `registry.json`, `PROTOCOL.md`, `<T-id>/{spec.md, state.json, round-N/{brief-*, *report/decision/verdict, ask-worker-*, answers-*, done-*}}`.

## Selfcheck

`node -e "import('jiti').then(...)" test/selfcheck.ts` — см. `package.json` → `npm test` (cycle-detect, verdict-парсинг, brief'ы, миграция реестра, параллельные задачи).

## Ограничения (v1)

- Одна роль в задаче — один агент; параллельность — через разные наборы.
- Q&A только worker→planner (mid-round); у planner/judge вопросы — end-of-round через артефакты.
- RPC-агенты живут пока жива сессия conductor'а; перезапуск сессии требует перерегистрации.
