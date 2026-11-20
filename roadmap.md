# Roadmap

## Рефакторинг v0.4 (согласован 2026-11-20)

### P0 — баги жизненного цикла и данных
- [x] `session_shutdown`: убирать таймеры, убивать rpc-детей (иначе два conductor'а после /new, /resume, /reload)
- [x] Restart-эскалация: писать `.escalate`-файл, иначе zombie-`runTask` затирает stage
- [x] Атомарные записи: state.json / registry.json / brief (tmp+rename); torn-JSON ≠ «задачи нет»
- [x] Единый sessionDir rpc-агента с момента регистрации (respawn `--continue` + read-loop детект watchdog'а)
- [x] `sendTo` на мёртвом rpc не должен ронять `runTask` в подвешенный stage
- [x] Имена слайсов из slices.json: строгая валидация (`[\w.-]+`, без `.`/`..`), отказ задачи
- [x] git merge: отличать конфликт от ошибки, `merge --abort` при неуспехе

### P1 — watchdog и чистка
- [x] env-пороги watchdog: только положительные числа
- [x] gitSig: не обрезать до 4000 (хешировать целиком)
- [x] heavy IO watchdog-тика не морозит event loop
- [x] Дубли: `resolveAgents` vs `tickQueue`, bootstrap-строка ×2, escalate+save+notify ×3, `.abort`/`state.json` литералы, `gitSig` мимо git.ts
- [x] Осиротевший rpc при перезаписи регистрации tmux
- [x] Worktree/ветки чистить и при escalate/abort (best effort)

### P2 — структура
- [x] `scheduler.ts` вынесён (resolveAgents/busyAgents/makeDeps/tickQueue/launchTask на шве AgentPool). Отдельные transport.ts/watchdog-wiring.ts не заведены: оставшиеся обёртки — тонкая проводка index, выносить без мотивации нет (index 532 строк, runtime ~150)
- [x] Тесты планировщика на фейковом AgentPool (запуск из очереди до pass, эскалация, launched, конфликт-чек)

### Инфраструктура
- [x] tsconfig: полный include (watchdog.ts, rpc.ts, git.ts, test/e2e.ts) + npm-скрипт typecheck
- [x] `npm test` = typecheck + selfcheck + e2e + e2e-slices
- [x] CI (ubuntu: npm ci, npm test)
- [x] stderr git не льётся в консоль pi

### Документация
- [x] README: актуализировать и сократить
- [ ] roadmap.md актуален (этот файл)

## Рефакторинг v0.5 (2026-11-21)

### P0 — что реально ломалось
- [x] rpc: JSONL читался по chunk'ам (`chunk.toString().split("\n")`) — запись на границе chunk'а и разрезанный посередине UTF-8 терялись, watchdog не видел `agent_settled`. Буфер `LineBuffer` (остаток + StringDecoder); слушатели `error` на stream'ах (EPIPE после смерти ребёнка — uncaught exception в процессе conductor'а).
- [x] rpc: `kill()` — флаг `killed` (после уборки не респауниться, иначе `session_shutdown` рождал сироту) + SIGKILL через 5 с, если orderly shutdown завис.
- [x] git: `.pi/` (состояние conductor'а) не считается работой агента. Без этого после первого же запуска дерево «не чистое» (slices навсегда недоступен в проекте, где `.pi` не в `.gitignore`), а watchdog считал чужие артефакты прогрессом и не нюджил.

### P1 — поведение
- [x] watchdog: «turn завершён (`agent_settled`), а done-файла нет» → nudge по `settleStuckMs` (3 мин, env `PI_CMDER_SETTLE_STUCK_MS`) вместо 15-минутного idle-порога; после исчерпания nudge'ов — эскалация. `prompt()` сбрасывает `lastSettledAt` (иначе settled считался бы со времени прошлого ответа и нюдж уходил бы сразу после брифа).
- [x] `pipeline_status`: сколько минут идёт активный этап; очередь показывает, какого агента и какой задачи ждёт.
- [x] Старт задачи из очереди уведомляется (раньше после «поставлен в очередь» было видно только финальный вердикт).
- [x] `busyAgents`: активная задача — приоритетная метка занятости (очередь перекрывала её, и `pipeline_agents` показывал «занят: T-queued» вместо того, кто держит агента).
- [x] `test/tools.ts`: инструменты index.ts под фейковым pi-хостом (формат `pipeline_status`, очередь, `pipeline_agents`, abort/remove) — раньше index не покрывался ничем, кроме «индекс грузится».

### Открыто (сознательно не сделано)
- [ ] Слияние sliced-задач сериализовано event loop'ом conductor'а (`git merge` синхронный) — внутри одного процесса гонки за index нет. Вторая задача в том же репо из ДРУГОГО conductor'а (вторая pi-сессия) даст конфликт `index.lock`; лечится worktree на проект, не кодом.
- [ ] Дедупликация «эскалации» (index / runTask / watchdog): общий код — 3 строки, тексты уведомлений осознанно разные; выносить нечего.
- [ ] `.abort`/`.escalate` и worktrees после escalate остаются на диске (нужны для разбора), уборка ручная.
