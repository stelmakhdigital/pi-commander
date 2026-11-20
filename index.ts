/**
 * commander — оркестрация зарегистрированных pi-агентов (tmux-панели и/или RPC-процессы)
 * в цепочку worker → planner → judge с loop'ом по вердикту судьи.
 * Conductor детерминирован (без LLM); LLM — только внутри агентов.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { RpcAgent } from "./rpc.ts";
import { head, isClean, isRepo } from "./git.ts";
import {
	ABORT_FILE,
	PIPELINE_DIR,
	ROLES,
	atomicWrite,
	findActiveTasks,
	findClaimingTasks,
	findQueuedTasks,
	readState,
	requestEscalation,
	saveState,
	surfaceStr,
	taskHistory,
	type Agent,
	type Role,
	type TaskState,
} from "./state.ts";
import { busyAgents, launchTask, resolveAgents, tickQueue, type AgentPool } from "./scheduler.ts";
import { isAlive as tmuxAlive, createWindow, createPane, sendLine } from "./tmux.ts";
import { Watchdog, wdConfig } from "./watchdog.ts";
import { PROTOCOL } from "./protocol.ts";
import { applyTemplate, listTemplates } from "./templates.ts";

export default function commander(pi: ExtensionAPI) {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	/** Задачи, застрявшие в активной стадии из-за рестарта conductor'а → честная эскалация.
	 *  Обязательно через requestEscalation (.escalate-файл): крутящийся zombie-runTask
	 *  смотрит именно на файл, stage в state.json он затёр бы следующим setStage. */
	try {
		for (const t of findActiveTasks(process.cwd())) {
			const note = "conductor перезапустился во время задачи — перезапусти (состояние: state.json)";
			requestEscalation(t, note);
			t.stage = "escalated";
			t.notes = note;
			saveState(t);
		}
	} catch {}

	/** RPC-агенты живут в памяти сессии conductor'а (имена → процесс). */
	const rpcAgents = new Map<string, RpcAgent>();

	/** Убить процесс и забыть агента (перезапись регистрации, удаление из реестра,
	 *  конец slice-воркера). Без этого процесс-сирота держит занятость невидимо. */
	const dropRpc = (name: string): void => {
		rpcAgents.get(name)?.kill();
		rpcAgents.delete(name);
	};

	/** Единый sessionDir rpc-агента: и при регистрации, и при респауне, и у
	 *  watchdog-детекта. Иначе --continue после респауна не находит сессий
	 *  (молча теряется память), а read-loop детект смотрит в пустой каталог. */
	const rpcSessionDir = (cwd: string, name: string): string => path.join(PIPELINE_DIR(cwd), "rpc", name, "sessions");
	const dirHasSessions = (d: string): boolean => {
		try {
			return fs.readdirSync(d).length > 0;
		} catch {
			return false;
		}
	};

	/** Lazy auto-respawn: мёртвый rpc-агент из реестра поднимается заново с --continue
	 * (память в его собственном session-dir), если процесс уже был в этой сессии. */
	const ensureRpc = (a: Agent, cwd: string): void => {
		if (a.surface.kind !== "rpc") return;
		if (a.name.includes("/")) return; // временные slice-агенты не респаунятся
		if (rpcAgents.get(a.name)?.alive) return;
		const sessionDir = rpcSessionDir(cwd, a.name);
		fs.mkdirSync(sessionDir, { recursive: true });
		const hadBefore = rpcAgents.has(a.name);
		rpcAgents.set(a.name, new RpcAgent({ cwd: a.surface.cwd ?? cwd, model: a.surface.model, sessionDir, resume: hadBefore || dirHasSessions(sessionDir) }));
	};

	const alive = (a: Agent) => (a.surface.kind === "tmux" ? tmuxAlive(a.surface.target) : rpcAgents.get(a.name)?.alive ?? false);
	const sendTo = (a: Agent, line: string, cwd: string) => {
		if (a.surface.kind === "tmux") {
			sendLine(a.surface.target, line);
			return;
		}
		ensureRpc(a, cwd);
		const rpc = rpcAgents.get(a.name);
		if (!rpc?.alive) throw new Error(`rpc-агент ${a.name} не поднялся (lastError: ${rpc?.lastError ?? "?"})`);
		rpc.prompt(line);
	};

	const ensureProtocol = (cwd: string): string => {
		const root = PIPELINE_DIR(cwd);
		fs.mkdirSync(root, { recursive: true });
		const f = path.join(root, "PROTOCOL.md");
		if (!fs.existsSync(f)) fs.writeFileSync(f, PROTOCOL);
		return f;
	};

	const notify = (t: string) => {
		try {
			pi.sendUserMessage(t);
		} catch {}
	};

	/** Стоп задачи: out-of-band маркер + состояние. Общий путь pipeline_abort и force-remove. */
	const stopTask = (t: TaskState, notes?: string): void => {
		fs.writeFileSync(path.join(t.dir, ABORT_FILE), "");
		t.stage = "aborted";
		if (notes) t.notes = notes;
		saveState(t);
	};

	/** Эскалация вне runTask (очередь и пр.): .escalate-файл + состояние + сигнал. */
	const escalateTask = (t: TaskState, reason: string): void => {
		requestEscalation(t, reason);
		t.stage = "escalated";
		t.notes = reason;
		saveState(t);
		notify(`[commander] ${t.id}: ESCALATION — ${reason}`);
	};

	/** Транспортный пул для планировщика/runTask: tmux + rpc-карта этой сессии. */
	const pool: AgentPool = {
		ensure: ensureRpc,
		alive,
		sendTo,
		spawnSliceWorker: async (task, sl, wt, model) => {
			const name = `${task.id}/${sl.name}`;
			const sessionDir = path.join(task.dir, "sessions", sl.name);
			fs.mkdirSync(sessionDir, { recursive: true });
			rpcAgents.set(name, new RpcAgent({ cwd: wt, model, sessionDir }));
			return { name, role: "worker" as const, surface: { kind: "rpc" as const, model } };
		},
		// только slice-агенты (имя «T-.../slice»); зарегистрированные не убиваем
		killAgent: (a) => {
			if (a.name.includes("/")) dropRpc(a.name);
		},
	};

	const launched = new Set<string>();

	const queueTimer = setInterval(() => tickQueue({ cwd: process.cwd(), pool, launched, notify, escalate: escalateTask }), 3000);
	queueTimer.unref();

	/** Watchdog: зацикливание/простой агентов в активных этапах → nudge → авто-эскалация. */
	const regAgent = (cwd: string, name?: string): Agent | undefined =>
		name ? loadRegistry(cwd).agents.find((x) => x.name === name) : undefined;
	const wdActors = (cwd: string, t: TaskState): Agent[] => {
		if (t.stage === "worker" && t.mode === "sliced" && t.round === 1) {
			const prefix = `${t.id}/`;
			return [...rpcAgents.entries()]
				.filter(([n, r]) => n.startsWith(prefix) && r.alive)
				.map(([n]) => ({ name: n, role: "worker" as const, surface: { kind: "rpc" as const } }));
		}
		if (t.stage === "judge") return [regAgent(cwd, t.agents?.planner), regAgent(cwd, t.agents?.judge)].filter((a): a is Agent => !!a); // planner ∥ judge
		if (t.stage === "worker") return [regAgent(cwd, t.agents?.worker)].filter((a): a is Agent => !!a);
		return [regAgent(cwd, t.agents?.planner)].filter((a): a is Agent => !!a); // decompose
	};
	const WD = wdConfig(); // пороги c учётом env PI_CMDER_*
	const wd = new Watchdog();
	const wdTimer = setInterval(() => {
		const cwd = process.cwd();
		wd.tick(cwd, {
			alive,
			notify,
			sendTo: (a, l) => sendTo(a, l, cwd),
			settled: (a) => {
				if (a.surface.kind !== "rpc") return false;
				const r = rpcAgents.get(a.name);
				return !!r?.lastSettledAt && Date.now() - Date.parse(r.lastSettledAt) > WD.settledMs;
			},
			sessionDir: (t, a) => {
				if (a.surface.kind !== "rpc") return null;
				if (a.name.includes("/")) return path.join(t.dir, "sessions", a.name.split("/").pop()!); // slice-агент
				return rpcSessionDir(cwd, a.name);
			},
			actors: (t) => wdActors(cwd, t),
			plannerOf: (t) => regAgent(cwd, t.agents?.planner) ?? null,
		});
	}, WD.tickMs);
	wdTimer.unref();

	/** По докам pi (extensions.md) ресурсы сессии обязаны закрываться в
	 *  session_shutdown: после /new, /resume, /reload создаётся новый инстанс,
	 *  а старые таймеры и rpc-дети дали бы два conductor'а на одну задачу. */
	pi.on("session_shutdown", () => {
		clearInterval(queueTimer);
		clearInterval(wdTimer);
		for (const r of rpcAgents.values()) r.kill();
		rpcAgents.clear();
	});

	pi.registerTool({
		name: "pipeline_run",
		label: "pipeline_run",
		description:
			"Запустить pipeline-цепочку worker→planner→judge. spec — путь к spec.md или текст задачи (обязателен раздел «Критерии приёмки»). agents — явный набор имён (для параллельных задач); по умолчанию первые зарегистрированные по ролям. Если агенты заняты — задача в очередь, стартует автоматически. slices — fan-out: planner дробит spec на 2..6 слайсов, воркеры параллельно в git worktrees (нужен git + чистое дерево + rpc-воркер). Loop идёт фоном, результат придёт сообщением.",
		parameters: Type.Object({
			spec: Type.String({ description: "Путь к spec.md или текст задачи" }),
			max_rounds: Type.Optional(Type.Number({ description: "Максимум раундов (default 3)" })),
			slices: Type.Optional(Type.Number({ description: "fan-out: 2..6 слайсов, параллельные воркеры в git worktrees" })),
			agents: Type.Optional(
				Type.Object({
					worker: Type.Optional(Type.String({ description: "имя worker-агента" })),
					planner: Type.Optional(Type.String({ description: "имя planner-агента" })),
					judge: Type.Optional(Type.String({ description: "имя judge-агента" })),
				}),
			),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const { agents, problems } = resolveAgents(pool, cwd, p.agents);
			if (problems.length) return text("Pipeline не запущен:\n- " + problems.join("\n- "));

			let specText: string;
			if (fs.existsSync(p.spec) && fs.statSync(p.spec).isFile()) specText = fs.readFileSync(p.spec, "utf8");
			else specText = p.spec;
			if (!/критерии приёмки/i.test(specText))
				return text("В spec нет раздела «Критерии приёмки» — судье нечем сверять. Шаблон: PROTOCOL.md §spec. Добавь и запусти заново.");

			// Sliced-режим (fan-out): planner дробит spec, воркеры параллельно в worktrees.
			let mode: "serial" | "sliced" = "serial";
			let sliceCount: number | undefined;
			if (p.slices !== undefined) {
				if (!Number.isInteger(p.slices) || p.slices < 2 || p.slices > 6) return text("slices: нужно целое 2..6.");
				if (!isRepo(cwd) || !isClean(cwd)) return text("slices: нужен git-репо с чистым деревом (закоммить/убери незакоммиченное).");
				const w = agents.find((a) => a.role === "worker");
				if (!w || w.surface.kind !== "rpc")
					return text(`slices: worker должен быть rpc (у «${w?.name ?? "?"}» — ${w?.surface.kind ?? "?"}); slice-воркеры conductor поднимает сам в git worktrees.`);
				mode = "sliced";
				sliceCount = p.slices;
			}

			let base_head: string | null = null;
			try {
				base_head = head(cwd);
			} catch {}
			if (p.slices !== undefined && !base_head)
				return text("slices: в репо нет ни одного коммита — worktree не от чего создать. Сделай базовый коммит.");

			const root = PIPELINE_DIR(cwd);
			ensureProtocol(cwd);
			let id = `T-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
			while (fs.existsSync(path.join(root, id))) id += "x"; // параллельный запуск в ту же секунду
			const dir = path.join(root, id);
			fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });
			atomicWrite(path.join(dir, "spec.md"), specText.trimEnd() + "\n");

			const task: TaskState = {
				id,
				dir,
				base_head,
				cwd,
				round: 1,
				stage: "worker",
				max_rounds: p.max_rounds ?? 3,
				history: [],
				agents: Object.fromEntries(ROLES.map((r) => [r, agents.find((a) => a.role === r)!.name])),
				mode,
				slice_count: sliceCount,
				started_at: new Date().toISOString(),
				stage_started_at: new Date().toISOString(),
			};
			saveState(task);

			const who = agents.map((a) => `${a.role}=${a.name}(${surfaceStr(a)})`).join(", ");
			const busy = busyAgents(cwd, id);
			const conflicts = agents.filter((a) => busy.has(a.name)).map((a) => `${a.name} занят: ${busy.get(a.name)}`);
			if (conflicts.length) {
				task.stage = "queued";
				saveState(task);
				return text(`${id} поставлен в очередь (агенты заняты: ${conflicts.join(", ")}). Стартует автоматически, когда освободятся. Прогресс: pipeline_status.`);
			}
			launchTask(task, agents, pool, notify, launched);
			return text(`${id} запущен: round 1 → ${mode === "sliced" ? `decompose → ${sliceCount} slice-воркера (worktrees)` : "worker"}. Агенты: ${who}. Прогресс: pipeline_status. Результат придёт сообщением.`);
		},
		renderCall(args, theme) {
			const sel = args.agents as Record<string, string> | undefined;
			const sub = sel ? ` [${ROLES.filter((r) => sel[r]).map((r) => sel[r]).join(", ")}]` : "";
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_run ")) + theme.fg("muted", `${args.spec}${sub}`));
		},
	});

	pi.registerTool({
		name: "pipeline_template",
		label: "pipeline_template",
		description:
			"Шаблоны инициализации нового проекта. Без name — список доступных шаблонов. name (например basic) — скопировать все файлы шаблона (каталог templates/<name>/ пакета) в корень текущего проекта; возможно только если в проекте ещё нет task.md (проект ещё не инициализирован). Новые шаблоны — новые директории в templates/, код не меняется.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Имя шаблона — директория в templates/ пакета (например basic). Без name — список шаблонов." })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			if (!p.name) {
				const list = listTemplates();
				return list.length
					? text(`Доступные шаблоны: ${list.join(", ")}. Применить в этом проекте: pipeline_template name=<имя>.`)
					: text("Шаблоны не найдены (каталог templates/ пакета пуст).");
			}
			try {
				const { copied } = applyTemplate(p.name, cwd);
				return text(`Шаблон «${p.name}» применён в ${cwd}: ${copied.join(", ")}. Дальше: при необходимости подправь task.md под проект, зарегистрируй агентов (pipeline_register) и запусти pipeline по task.md.`);
			} catch (e) {
				return text(`Шаблон «${p.name}» не применён: ${(e as Error).message}`);
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_template ")) + theme.fg("muted", args.name ?? "список"));
		},
	});

	pi.registerTool({
		name: "pipeline_status",
		label: "pipeline_status",
		description: "Статус pipeline-задач. Без id — все активные + последние завершённые; id — конкретная.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "id задачи (T-...)" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const render = (t: TaskState) => {
				const lines = [`${t.id}: stage=${t.stage} round=${t.round}/${t.max_rounds}${t.agents ? ` [${Object.values(t.agents).join(", ")}]` : ""}`];
				if (t.notes) lines.push(`notes: ${t.notes}`);
				for (const h of t.history) lines.push(`round ${h.round}: ${h.verdict}${h.issues.length ? ` (${h.issues.length} issues)` : ""}${h.notes ? ` — ${h.notes}` : ""}`);
				for (const e of fs.existsSync(t.dir) ? fs.readdirSync(t.dir, { withFileTypes: true }) : []) {
					if (e.isDirectory() && e.name.startsWith("round-")) {
						const files = fs.readdirSync(path.join(t.dir, e.name));
						lines.push(`${e.name}: ${files.join(", ") || "—"}`);
					}
				}
				return lines.join("\n");
			};
			if (p.id) {
				const t = readState(cwd, p.id);
				return text(t ? render(t) : `Задача ${p.id} не найдена.`);
			}
			const active = findActiveTasks(cwd);
			const queued = findQueuedTasks(cwd);
			const done = taskHistory(cwd).filter((t) => !active.some((a) => a.id === t.id) && t.stage !== "queued").slice(-3);
			if (!active.length && !queued.length && !done.length) return text("Задач нет.");
			let out = active.length ? `Активные:\n\n${active.map(render).join("\n\n")}` : "Активных нет.";
			if (queued.length) out += `\n\nВ очереди: ${queued.map((t) => `${t.id} [${Object.values(t.agents ?? {}).join(", ")}]${t.mode === "sliced" ? ` slices=${t.slice_count}` : ""}`).join(", ")}`;
			return text(out + (done.length ? `\n\nПоследние: ${done.map((t) => `${t.id} [${t.stage}] ${t.notes ?? ""}`).join("; ")}` : ""));
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_status ")) + theme.fg("muted", args.id ?? "все"));
		},
	});

	pi.registerTool({
		name: "pipeline_register",
		label: "pipeline_register",
		description:
			"Зарегистрировать pipeline-агента и отправить bootstrap. kind=tmux (default): существующая pi-сессия в tmux-пане (pane). kind=tmux-auto: conductor сам откроет отдельное окно с pi. kind=tmux-split: откроет split-панель в окне conductor'а (все агенты видны сразу). kind=rpc: conductor поднимет `pi --mode rpc` (model, cwd опциональны). Разрешено несколько агентов на роль (для параллельных задач).",
		parameters: Type.Object({
			name: Type.String({ description: "Имя агента" }),
			role: Type.String({ description: "Роль: worker | planner | judge" }),
			kind: Type.Optional(Type.Union([Type.Literal("tmux"), Type.Literal("tmux-auto"), Type.Literal("tmux-split"), Type.Literal("rpc")], { description: "default: tmux; tmux-auto = отдельное окно, tmux-split = плитка в окне conductor'а" })),
			pane: Type.Optional(Type.String({ description: "tmux-панель, например %12" })),
			model: Type.Optional(Type.String({ description: "модель (kind=rpc)" })),
			cwd: Type.Optional(Type.String({ description: "рабочий каталог (kind=rpc; default: каталог проекта)" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const role = p.role as Role;
			if (!ROLES.includes(role)) return text(`Неизвестная роль «${p.role}». Допустимо: ${ROLES.join(", ")}.`);
			const kind = p.kind ?? "tmux";
			let surface: Agent["surface"];
			// bootstrap-строка одна на все kind (раньше была продублирована в двух местах)
			const proto = ensureProtocol(cwd);
			const boot = `[pipeline] Ты агент ${p.name} в pipeline, роль: ${role}. Прочитай ${proto} (раздел «${role}» + общие правила + §Q&A) и ответь одним словом «готов». Задачи будут приходить как [pipeline T-... R-n → ${role}].`;
			if (kind === "tmux") {
				if (!p.pane) return text("Для kind=tmux нужен pane (например %12).");
				if (!tmuxAlive(p.pane)) return text(`Панель ${p.pane} не найдена (tmux list-panes: проверь номер).`);
				// перезапись rpc-регистрации tmux-панелью: процесс-сирота держит занятость невидимо
				dropRpc(p.name);
				surface = { kind: "tmux", target: p.pane };
			} else if (kind === "tmux-auto" || kind === "tmux-split") {
				const source = process.env.TMUX_PANE;
				if (!source) return text("tmux-auto/split: pi не запущен внутри tmux (нет $TMUX_PANE). Возьми kind=tmux (свою панель) или kind=rpc.");
				dropRpc(p.name);
				try {
					const pane = kind === "tmux-auto" ? createWindow(source, p.name, `pi '${boot}'`) : createPane(source, `pi '${boot}'`);
					surface = { kind: "tmux", target: pane };
				} catch (e) {
					return text(`Не удалось открыть окно/панель: ${(e as Error).message}`);
				}
			} else {
				// один путь подъёма rpc-процесса — ensureRpc (session-dir, resume, lazy-рестарт)
				surface = { kind: "rpc", model: p.model, cwd: p.cwd ?? cwd };
				try {
					dropRpc(p.name);
					ensureRpc({ name: p.name, role, surface }, cwd);
				} catch (e) {
					return text(`Не удалось поднять rpc-процесс: ${(e as Error).message}. Проверь, что \`pi\` в PATH.`);
				}
			}
			const reg = loadRegistry(cwd);
			reg.agents = reg.agents.filter((a) => a.name !== p.name);
			reg.agents.push({ name: p.name, role, surface });
			saveRegistry(cwd, reg);
			// tmux-auto/split: bootstrap уже ушёл стартовым промптом панели, повторно не шлём
			if (kind === "tmux") sendLine(p.pane!, boot);
			else if (kind === "rpc") rpcAgents.get(p.name)?.prompt(boot);
			return text(`Зарегистрирован: ${p.name} (${role}, ${surfaceStr({ name: p.name, role, surface })}). Bootstrap отправлен — проверь ответ «готов».`);
		},
		renderCall(args, theme) {
			const surf = args.kind === "rpc" ? `rpc${args.model ? ` ${args.model}` : ""}` : args.pane ?? "";
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_register ")) + theme.fg("muted", `${args.name} → ${args.role} (${surf})`));
		},
	});

	pi.registerTool({
		name: "pipeline_agents",
		label: "pipeline_agents",
		description: "Список зарегистрированных pipeline-агентов: роль, транспорт, живость; активные задачи и занятость. Мёртвые агенты остаются в реестре — удалять: pipeline_remove name=... или dead=true.",
		parameters: Type.Object({}),
		async execute(_id, _p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const reg = loadRegistry(cwd);
			if (!reg.agents.length) return text("Никто не зарегистрирован. pipeline_register name=... role=... [pane=... | kind=rpc]");
			const busy = busyAgents(cwd);
			const lines = reg.agents.map((a) => {
				const ok = alive(a);
				const b = busy.get(a.name);
				return `${a.name} — ${a.role}, ${surfaceStr(a)} ${ok ? "✓" : "✗ МЁРТВ"}${b ? ` (занят: ${b})` : ""}`;
			});
			const active = findActiveTasks(cwd);
			lines.push(active.length ? `активные: ${active.map((t) => `${t.id} [${t.stage}] R${t.round}`).join(", ")}` : "активных задач нет");
			return text(lines.join("\n"));
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_agents ")));
		},
	});

	pi.registerTool({
		name: "pipeline_remove",
		label: "pipeline_remove",
		description:
			"Удалить pipeline-агента из реестра (мёртвые tmux-панели/rpc-процессы остаются в реестре навсегда, если не удалять). name — конкретный агент; dead=true — всех мёртвых сразу; force — удалить даже занятого (его задачи будут остановлены). Для rpc-агента процесс убивается.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Имя агента из реестра" })),
			dead: Type.Optional(Type.Boolean({ description: "Удалить всех мёртвых (name игнорируется)" })),
			force: Type.Optional(Type.Boolean({ description: "Удалить даже если агент занят в активной/очередной задаче (задача остановится)" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const reg = loadRegistry(cwd);
			if (!reg.agents.length) return text("Реестр пуст — удалять некого.");
			const targets = p.name ? reg.agents.filter((a) => a.name === p.name) : p.dead ? reg.agents.filter((a) => !alive(a)) : [];
			if (p.name && !targets.length) return text(`Агент «${p.name}» не найден в реестре (pipeline_agents).`);
			if (!p.name && !targets.length) return text(p.dead ? "Мёртвых агентов нет — реестр чистый." : "Укажи name или dead=true.");
			const busy = busyAgents(cwd);
			const out: string[] = [];
			for (const a of targets) {
				const b = busy.get(a.name);
				if (b && !p.force) {
					out.push(`пропущен ${a.name} (занят: ${b}); чтобы удалить — force=true (задача остановится)`);
					continue;
				}
				if (b) {
					for (const t of findClaimingTasks(cwd)) {
						if (Object.values(t.agents ?? {}).includes(a.name)) {
							stopTask(t, `агент ${a.name} удалён из реестра (force)`);
							out.push(`задача ${t.id} остановлена (агент ${a.name} занят в ней)`);
						}
					}
				}
				if (a.surface.kind === "rpc") dropRpc(a.name);
				reg.agents = reg.agents.filter((x) => x.name !== a.name);
				out.push(`удалён: ${a.name} (${a.role}, ${surfaceStr(a)})`);
			}
			saveRegistry(cwd, reg);
			return text(out.join("\n"));
		},
		renderCall(args, theme) {
			const what = args.name ?? (args.dead ? "все мёртвые" : "?");
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_remove ")) + theme.fg("muted", what + (args.force ? " force" : "")));
		},
	});

	pi.registerTool({
		name: "pipeline_send",
		label: "pipeline_send",
		description: "Отправить сообщение зарегистрированному pipeline-агенту (отладка, ручная помощь, ad-hoc). Не часть chain-протокола.",
		parameters: Type.Object({
			name: Type.String({ description: "Имя агента из реестра" }),
			message: Type.String({ description: "Сообщение (для tmux — одна строка, для rpc — можно многострочное)" }),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const a = loadRegistry(cwd).agents.find((x) => x.name === p.name);
			if (!a) return text(`Агент «${p.name}» не найден в реестре.`);
			if (a.surface.kind === "rpc") ensureRpc(a, cwd);
			if (!alive(a)) return text(`Агент ${p.name}: не жив.`);
			await sendTo(a, p.message, cwd);
			return text(`Отправлено в ${p.name} (${surfaceStr(a)}).`);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_send ")) + theme.fg("muted", `${args.name}: ${String(args.message).slice(0, 60)}`));
		},
	});

	pi.registerTool({
		name: "pipeline_abort",
		label: "pipeline_abort",
		description: "Остановить pipeline-задачу (id; без id — все активные). Текущий этап агента не прерывается, цикл не продолжится.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "id задачи; по умолчанию все активные" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const targets = p.id ? [readState(cwd, p.id)].filter((t): t is TaskState => !!t) : findClaimingTasks(cwd);
			if (!targets.length) return text(p.id ? `Задача ${p.id} не найдена или не активна.` : "Активных задач нет.");
			for (const t of targets) stopTask(t);
			return text(`Aborted: ${targets.map((t) => t.id).join(", ")}. Агенты доделают текущий этап, цикл не продолжится.`);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_abort ")) + theme.fg("muted", args.id ?? "все активные"));
		},
	});
}
