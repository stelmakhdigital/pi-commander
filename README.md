# commander

pi-пакет: связывает **зарегистрированные долгоживущие pi-агенты** в рабочую цепочку **worker → planner → judge** с loop'ом по вердикту судьи.

## Модель

- **Агенты** — живые pi-сессии, три способа:
  - `tmux` — твоя уже запущенная pi-сессия в tmux-пане (conductor пишет `send-keys`);
  - `tmux-auto` — conductor сам открывает отдельное tmux-окно с `pi` (имя окна = имя агента; bootstrap улетает стартовым промптом, без гонок таймингов); агент виден, переживает рестарт conductor'а;
  - `tmux-split` — как `tmux-auto`, но плитка (split-панель) в окне conductor'а: все агенты видны сразу, без переключений вкладок (~¼ экрана на агента);
  - `rpc` — `pi --mode rpc`, дочерний процесс conductor'а (JSONL-протокол).
- **Conductor** — это расширение в твоей основной pi-сессии. Детерминированный TS state machine, без LLM. Для tmux — одна строка-указатель на brief-файл (многострочный ввод ломал бы TUI); для RPC — prompt по JSONL.
- **Сигнал готовности** этапа = done-файл на диске (часть протокола, а не транспорта) + валидный артефакт.
- **Mid-round Q&A**: worker застрял без решения архитектора → `round-N/ask-worker.md` → conductor ретранслирует planner'у → `answers-<k>.md` → worker продолжает. Лимит 3 Q&A/этап (против зацикливания).
- **Watchdog (анти-зацикливание)**: каждые 30с сравнивает «сигнатуру прогресса» этапа (git status/diff + артефакты задачи, без `.pi/`). Без прогресса 15 мин → nudge агенту (максимум 2), 45 мин или этап дольше 3 ч → авто-эскалация. Для rpc-агентов: turn завершился (`agent_settled`), а done-файла нет 3 мин → nudge сразу, без idle-порога («забыл финальный шаг» — самый частый стоп); повторяющееся действие ≥6 раз без единой мутации → nudge сразу. Пороги настраиваются env `PI_CMDER_*` (только положительные).
- **Параллельность, три уровня:**
  1. *Внутри раунда* — planner и judge работают одновременно.
  2. *Между задачами* — занятые агенты? Задача стоит в очереди (`stage=queued`) и стартует автоматически (FIFO). У каждой задачи свой набор агентов.
  3. *Внутри задачи (slices)* — `pipeline_run(spec, slices=N)`: planner дробит spec на 2..N слайсов, под каждый conductor поднимает отдельного rpc-воркера в git worktree, затем merge и оценка итогового diff. Раунды 2+ — обычный worker. Нужно: git, чистое дерево (`.pi/` не считается), rpc-воркер; merge-конфликт — эскалация (worktrees остаются).
```
Ты ── pipeline_run(spec, agents?, slices?) ──► CONDUCTOR (extension, state machine)
                                        │ round N: worker → (planner ∥ judge)
   tmux pane %12 ◄─send-keys───────────┤    (каждый: brief → артефакт → done-файл)
   rpc proc (pi --mode rpc) ◄─JSONL────┤    (worker может mid-round спросить planner'а)
   tmux pane %7  ◄──────────────────────┘    pass → готово
                                             revise → round N+1 | blocked / max_rounds / cycle / Q&A-loop / watchdog → эскалация
                                             sliced: round 1 = decompose → N worker'ов в worktrees → merge
                                             занятые агенты → очередь (старт при освобождении)
```

## Install

`~/.pi/agent/settings.json` → `packages`:

```json
{ "source": "git:github.com:stelmakhdigital/pi-commander.git" }
```

(локально: `{ "source": "file:/path/to/commander" }`)

## Быстрый старт (5 минут)

**0. Установить.** `~/.pi/agent/settings.json` → `packages` (см. Install ниже), перезапустить pi. Дальше всё через естественный язык в основной pi-сессии (в каталоге проекта).

**1. Три агента.** Быстрее всего — conductor сам откроет панели с pi:

```
Зарегистрируй трёх агентов kind=tmux-auto: w1 — worker, p1 — planner, j1 — judge
```

(альтернативы: `kind=tmux-split` — плитки в твоём окне; `kind=rpc` — без tmux вообще; `kind=tmux` — твоя уже открытая pi-сессия, нужен pane id из `tmux list-panes -s -F "#{pane_id} #{pane_current_path} #{pane_current_command}"`).

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

- Та же команда при занятых агентах: `T-... поставлен в очередь` — стартует автоматически, когда набор освободится (придёт `[commander] T-...: старт из очереди`).
- Большая задача с независимыми кусками: `Запусти pipeline по task.md с slices=3` (fan-out в git worktrees; нужен git + чистое дерево (`.pi/` не считается) + rpc-воркер).

**4. Результат** — придёт сообщением сам:

- `[commander] T-...: PASS за 2 раунда.` → смотри diff, коммить.
- `[commander] T-...: ESCALATION — ...` → читай `notes` в `pipeline_status`: поправь spec / перезапущай / доделай руками. Вся история — в `.pi/pipeline/<T-id>/`.

**Пока задача летит:**

| Скажи | Что сделает |
|---|---|
| «Какой статус pipeline?» | `pipeline_status` — стадия (сколько минут в этапе), раунд, вердикты, артефакты; очередь с указанием, какого агента ждёт |
| «Останови задачу» / «останови всё» | `pipeline_abort [id]` |
| «Скажи worker'у: ...» | `pipeline_send` (ad-hoc) |
| «Агент мёртв, убери его из реестра» | `pipeline_remove name=...` (или `dead=true` — всех мёртвых) |

**Параллельно:** второй набор агентов + `Запусти pipeline по spec-B.md с agents={worker: w2, planner: p2, judge: j2}`. Тот же набор агентов — просто запусти вторую задачу: она встанет в очередь за первой. Один репо — два набора = git worktree (judge оценивает `git diff` в своём cwd).

## Шаблоны (новый проект)

В новом (ещё пустом) проекте вместо своего spec можно применить готовый шаблон пакета:

```
pi-commander реализуй шаблон basic
```

Conductor вызовет `pipeline_template name=basic` и скопирует все файлы из каталога `templates/basic/` пакета в корень проекта. Шаблон применяется **только если в проекте ещё нет `task.md`** (проект считается не инициализированным); повторное применение отклоняется.

- Без имени (`pipeline_template` без аргументов) возвращается список доступных шаблонов.
- **Новый шаблон = новая директория** `templates/<name>/` в пакете — код не меняется, он сразу появляется в списке.

### Шаблон `basic`

- `task.md` — универсальный spec автономного цикла: цель + критерии приёмки + референсы + правила + границы; внутри — git-протокол (каждый подагент в своей ветке `agent/<role>/<iteration>`, только worker принимает решение о merge/push).
- `worker_roles.md` — каталог ролей подагентов (backend, frontend, tester, reviewer, devops, docs) с назначением, обязанностями, критериями готовности и секцией «Активные роли текущей итерации».
- `worker_prompt_addition.md` — обязательное правило: перед каждой итерацией worker читает `worker_roles.md` и запускает по одному подагенту на каждую активную роль (не выполняет работу единолично, а управляет подагентами).

## Инструменты

| Tool | Зачем |
|---|---|
| `pipeline_run` | запуск: spec (+ явный набор агентов, + `slices=N` для fan-out) → цикл; занятые агенты = очередь |
| `pipeline_template` | шаблоны нового проекта: список (без name) или копирование файлов шаблона `templates/<name>/` в корень проекта (только пока нет `task.md`) |
| `pipeline_status` | задачи: активные (стадия + сколько минут в этапе, раунд, вердикты, артефакты) + очередь (из-за какого агента стоит) + последние завершённые |
| `pipeline_register` | агент (tmux-панель или RPC) + роль в реестр + bootstrap |
| `pipeline_agents` | реестр + живость + занятость в задачах |
| `pipeline_remove` | удалить агента из реестра: `name` / всех мёртвых `dead=true` / занятого `force` (его задача остановится); rpc-процесс убивается |
| `pipeline_send` | сообщение агенту (ad-hoc/отладка) |
| `pipeline_abort` | остановить задачу (id) или все активные |

## Loop и guardrails

`round: worker → (planner ∥ judge) → pass | revise (round N+1) | blocked (к тебе)`. В sliced-раунде 1 перед worker'ами — decompose (planner → slices.json → N worktrees).
Эскалация: `max_rounds` (default 3), **cycle-detect** (findings двух раундов >50% совпадают), Q&A-loop (>3 вопросов за этап), мёртвый агент, невалидный verdict судьи после повторного запроса, merge-конфликт слайсов (sliced), watchdog (простой, read-loop, завершённый turn без done-файла). Мягкие пороги (45 мин этап / 15 мин Q&A) работу НЕ откатывают: conductor уведомляет и ждёт, пока агент жив.

## Рестарты conductor'а
- **RPC-агенты**: lazy auto-respawn — при первом обращении мёртвый агент из реестра поднимается заново: `--session-dir` изолирован на агента, `--continue` — агент помнит прошлые задачи. Без перерегистрации.
- **Задачи в очереди** переживают рестарт: планировщик запустит их, когда агенты будут готовы.
- **Задачи, застрявшие в активной стадии** при рестарте: автоматически `escalated: conductor перезапустился` (state.json жив — перезапусти или доделай руками; sliced-worktrees остаются на диске — `git worktree list` / `remove`).
- **tmux/tmux-auto панели**: живы, пока жив tmux-сервер; registry хранит pane id.

## Layout

`.pi/pipeline/` — `registry.json`, `PROTOCOL.md`, `<T-id>/{spec.md, state.json, round-N/{brief-*, *report/decision/verdict, ask-worker-*, answers-*, done-*}}`, в sliced-режиме ещё `<T-id>/worktrees/<slice>` (чистятся по pass и abort; при merge-конфликте остаются для ручного разрешения) и `round-1/slice-<k>/…`.

## Тесты и CI

`npm test` — полный гейт: `tsc --noEmit` (все модули, включая watchdog/rpc/git) + selfcheck (парсинг, cycle-detect, очереди/scheduler на фейковом транспорте, watchdog-сигнатуры, JSONL-фрейминг rpc, git-проверки) + e2e (`runTask`: Q&A, revise→pass, abort) + e2e-slices (реальный git: worktrees, merge, cleanup) + tools (инструменты index.ts на фейковом pi-хосте: форматы `pipeline_status`, занятость, abort/remove). Всё без tmux, сети и LLM. CI (GitHub Actions, ubuntu) гоняет `npm test`.

## Ограничения (v1)

- Одна роль в задаче — один агент; параллельность — через очередь, разные наборы и slices.
- Slices: round 1 — fan-out в worktrees (только rpc-воркеры); раунды 2+ — обычный один worker. Слайсы дробит planner — качество fan-out = качество `slices.json` (конфликтующие scope = merge-эскалация).
- Q&A только worker→planner (mid-round); у planner/judge вопросы — end-of-round через артефакты.
- RPC-агент при respawn продолжает свою последнюю сессию (--continue в его session-dir). Если «память» вредна — перерегистрируй с новым именем (чистый session-dir).
