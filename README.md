# commander

pi-пакет: связывает **зарегистрированные долгоживущие pi-агенты** в рабочую цепочку **worker → planner → judge** с loop'ом по вердикту судьи.

## Модель

- **Агенты** — живые pi-сессии, три способа:
  - `tmux` — твоя уже запущенная pi-сессия в tmux-пане (conductor пишет `send-keys`);
  - `tmux-auto` — conductor сам открывает панель с `pi` (bootstrap улетает стартовым промптом, без гонок таймингов); агент виден, переживает рестарт conductor'а;
  - `rpc` — `pi --mode rpc`, дочерний процесс conductor'а (JSONL-протокол).
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

## Быстрый старт (5 минут)

**0. Установить.** `~/.pi/agent/settings.json` → `packages` (см. Install ниже), перезапустить pi. Дальше всё через естественный язык в основной pi-сессии (в каталоге проекта).

**1. Три агента.** Либо свои панели:

```
Зарегистрируй %12 как worker, %7 как planner, %15 как judge
```

Либо вообще без панелей — conductor сам откроет три панели с pi:

```
Зарегистрируй трёх агентов kind=tmux-auto: w1 — worker, p1 — planner, j1 — judge
```

Проверка: «Какие pipeline-агенты зарегистрированы?» → `pipeline_agents`, все с ✓.

**2. Spec.** Файл `task.md` в проекте (или текст прямо в команде):

```markdown
## Цель — 1–3 предложения: что считается «сделано»
## Критерии приёмки — observable-чеклист (файл/тест/поведение) ← ОБЯЗАТЕЛЬНО
## Референсы — файлы/паттерны, на которые опираться
## Правила — запреты
## Границы — что НЕ входит
```

**3. Запуск.**

```
Запусти pipeline по task.md
```

Ответ: `T-2025... запущен: round 1 → worker`. Дальше цикл идёт фоном, ты свободен.

**4. Результат** — придёт сообщением сам:

- `[commander] T-...: PASS за 2 раунда.` → смотри diff, коммить.
- `[commander] T-...: ESCALATION — ...` → читай `notes` в `pipeline_status`: поправь spec / перезапущай / доделай руками. Вся история — в `.pi/pipeline/<T-id>/`.

**Пока задача летит:**

| Скажи | Что сделает |
|---|---|
| «Какой статус pipeline?» | `pipeline_status` — стадия, раунд, вердикты, артефакты |
| «Останови задачу» / «останови всё» | `pipeline_abort [id]` |
| «Скажи worker'у: ...» | `pipeline_send` (ad-hoc) |

**Параллельно:** второй набор агентов + `Запусти pipeline по spec-B.md с agents={worker: w2, planner: p2, judge: j2}`. Один репо — два набора = git worktree (judge оценивает `git diff` в своём cwd).

## Инструменты

| Tool | Зачем |
|---|---|
| `pipeline_run` | запуск: spec (+ явный набор агентов) → цикл worker→planner→judge |
| `pipeline_status` | активные задачи: стадия, раунд, история вердиктов, артефакты |
| `pipeline_register` | агент (tmux-панель или RPC) + роль в реестр + bootstrap |
| `pipeline_agents` | реестр + живость + занятость в задачах |
| `pipeline_send` | сообщение агенту (ad-hoc/отладка) |
| `pipeline_abort` | остановить задачу (id) или все активные |

## Loop и guardrails

`round: worker → planner → judge → pass | revise (round N+1) | blocked (к тебе)`.
Эскалация: `max_rounds` (default 3), **cycle-detect** (findings двух раундов >50% совпадают), Q&A-loop (>3 вопросов за этап), Q&A-таймаут (15 мин), таймаут этапа (45 мин), мёртвый агент, невалидный verdict судьи после повторного запроса.

## Рестарты conductor'а
- **RPC-агенты**: lazy auto-respawn — при первом обращении мёртвый агент из реестра поднимается заново: `--session-dir` изолирован на агента, `--continue` — агент помнит прошлые задачи. Без перерегистрации.
- **Задачи, застрявшие в активной стадии** при рестарте: автоматически `escalated: conductor перезапустился` (state.json жив — перезапусти или доделай руками).
- **tmux/tmux-auto панели**: живы, пока жив tmux-сервер; registry хранит pane id.

## Layout

`.pi/pipeline/` — `registry.json`, `PROTOCOL.md`, `<T-id>/{spec.md, state.json, round-N/{brief-*, *report/decision/verdict, ask-worker-*, answers-*, done-*}}`.

## Selfcheck

`node -e "import('jiti').then(...)" test/selfcheck.ts` — см. `package.json` → `npm test` (cycle-detect, verdict-парсинг, brief'ы, миграция реестра, параллельные задачи).

## Ограничения (v1)

- Одна роль в задаче — один агент; параллельность — через разные наборы.
- Q&A только worker→planner (mid-round); у planner/judge вопросы — end-of-round через артефакты.
- RPC-агент при respawn продолжает свою последнюю сессию (--continue в его session-dir). Если «память» вредна — перерегистрируй с новым именем (чистый session-dir).
