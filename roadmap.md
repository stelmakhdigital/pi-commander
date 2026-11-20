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
