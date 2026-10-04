/**
 * commander — оркестрация зарегистрированных pi-агентов (tmux-панели и/или RPC-процессы)
 * в цепочку worker → planner → judge с loop'ом по вердикту судьи.
 * Conductor детерминирован (без LLM); LLM — только внутри агентов.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { RpcAgent } from "./rpc.ts";
import {
	PIPELINE_DIR,
	ROLES,
	findActiveTasks,
	readState,
	runTask,
	saveState,
	taskHistory,
	type Agent,
	type Role,
	type TaskState,
} from "./state.ts";
import { isAlive as tmuxAlive, createPane, sendLine } from "./tmux.ts";
import { PROTOCOL } from "./protocol.ts";

export default function commander(pi: ExtensionAPI) {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	/** Задачи, застрявшие в активной стадии из-за рестарта conductor'а → честная эскалация. */
	try {
		for (const t of findActiveTasks(process.cwd())) {
			t.stage = "escalated";
			t.notes = "conductor перезапустился во время задачи — перезапусти (состояние: state.json)";
			saveState(t);
		}
	} catch {}

	/** RPC-агенты живут в памяти сессии conductor'а (имена → процесс). */
	const rpcAgents = new Map<string, RpcAgent>();

	/** Lazy auto-respawn: мёртвый rpc-агент из реестра поднимается заново с --continue
	 * (память в его собственном session-dir), если процесс уже был в этой сессии. */
	const ensureRpc = (a: Agent, cwd: string): void => {
		if (a.surface.kind !== "rpc") return;
		if (rpcAgents.get(a.name)?.alive) return;
		const sessionDir = path.join(PIPELINE_DIR(cwd), "rpc", a.name, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const hadBefore = rpcAgents.has(a.name);
		rpcAgents.set(a.name, new RpcAgent({ cwd: a.surface.cwd ?? cwd, model: a.surface.model, sessionDir, resume: hadBefore }));
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

	const surfaceStr = (a: Agent) => (a.surface.kind === "tmux" ? `tmux ${a.surface.target}` : `rpc${a.surface.model ? ` ${a.surface.model}` : ""}`);

	/** Разбор набора агентов задачи: явно (имена) или дефолтные (первые по ролям). */
	const resolveAgents = (cwd: string, sel?: { worker?: string; planner?: string; judge?: string }): { agents: Agent[]; problems: string[] } => {
		const reg = loadRegistry(cwd);
		const problems: string[] = [];
		const agents: Agent[] = [];
		for (const r of ROLES) {
			const name = sel?.[r];
			const a = name ? reg.agents.find((x) => x.name === name) : reg.agents.find((x) => x.role === r);
			if (a && a.surface.kind === "rpc") ensureRpc(a, cwd);
			if (!a) {
				problems.push(name ? `агент «${name}» не найден в реестре (роль ${r})` : `нет агента с ролью ${r} (pipeline_register)`);
				continue;
			}
			if (!alive(a)) {
				problems.push(`агент ${a.name} (${r}, ${surfaceStr(a)}): не жив`);
				continue;
			}
			agents.push(a);
		}
		return { agents, problems };
	};

	/** Конфликт-чек: агент уже занят в другой активной задаче (параллельные задачи). */
	const busyAgents = (cwd: string, exceptId?: string): Map<string, string> => {
		const busy = new Map<string, string>();
		for (const t of findActiveTasks(cwd)) {
			if (t.id === exceptId) continue;
			for (const [r, name] of Object.entries(t.agents ?? {})) if (name) busy.set(name, `${t.id} (${r})`);
		}
		return busy;
	};

	pi.registerTool({
		name: "pipeline_run",
		label: "pipeline_run",
		description:
			"Запустить pipeline-цепочку worker→planner→judge. spec — путь к spec.md или текст задачи (обязателен раздел «Критерии приёмки»). agents — явный набор имён (для параллельных задач); по умолчанию первые зарегистрированные по ролям. Агенты не должны быть заняты в другой активной задаче. Loop идёт фоном, результат придёт сообщением.",
		parameters: Type.Object({
			spec: Type.String({ description: "Путь к spec.md или текст задачи" }),
			max_rounds: Type.Optional(Type.Number({ description: "Максимум раундов (default 3)" })),
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
			const { agents, problems } = resolveAgents(cwd, p.agents);
			if (problems.length) return text("Pipeline не запущен:\n- " + problems.join("\n- "));
			const busy = busyAgents(cwd);
			const conflicts = agents.filter((a) => busy.has(a.name)).map((a) => `${a.name} занят: ${busy.get(a.name)}`);
			if (conflicts.length) return text("Не запущен — агенты заняты в другой активной задаче:\n- " + conflicts.join("\n- ") + "\nДождись завершения или задай другой набор (agents={...}).");

			let specText: string;
			if (fs.existsSync(p.spec) && fs.statSync(p.spec).isFile()) specText = fs.readFileSync(p.spec, "utf8");
			else specText = p.spec;
			if (!/критерии приёмки/i.test(specText))
				return text("В spec нет раздела «Критерии приёмки» — судье нечем сверять. Шаблон: PROTOCOL.md §spec. Добавь и запусти заново.");

			const root = PIPELINE_DIR(cwd);
			ensureProtocol(cwd);
			let id = `T-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
			while (fs.existsSync(path.join(root, id))) id += "x"; // параллельный запуск в ту же секунду
			const dir = path.join(root, id);
			fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });
			fs.writeFileSync(path.join(dir, "spec.md"), specText.trimEnd() + "\n");

			let base_head: string | null = null;
			try {
				base_head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			} catch {}

			const task: TaskState = {
				id,
				dir,
				base_head,
				round: 1,
				stage: "worker",
				max_rounds: p.max_rounds ?? 3,
				history: [],
				agents: Object.fromEntries(ROLES.map((r) => [r, agents.find((a) => a.role === r)!.name])),
				started_at: new Date().toISOString(),
			};
			fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(task, null, 2));

			runTask(task, { agents, sendTo: (a, line) => sendTo(a, line, cwd), alive, notify }).catch((err) => notify(`[commander] ${id}: ОШИБКА: ${(err as Error)?.message ?? err}`));

			const who = agents.map((a) => `${a.role}=${a.name}(${surfaceStr(a)})`).join(", ");
			return text(`${id} запущен: round 1 → worker. Агенты: ${who}. Прогресс: pipeline_status. Результат придёт сообщением.`);
		},
		renderCall(args, theme) {
			const sel = args.agents as Record<string, string> | undefined;
			const sub = sel ? ` [${ROLES.filter((r) => sel[r]).map((r) => sel[r]).join(", ")}]` : "";
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_run ")) + theme.fg("muted", `${args.spec}${sub}`));
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
			const done = taskHistory(cwd).filter((t) => !active.some((a) => a.id === t.id)).slice(-3);
			if (!active.length && !done.length) return text("Задач нет.");
			const out = active.length ? `Активные:\n\n${active.map(render).join("\n\n")}` : "Активных нет.";
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
			"Зарегистрировать pipeline-агента и отправить bootstrap. kind=tmux (default): существующая pi-сессия в tmux-пане (pane). kind=tmux-auto: conductor сам откроет панель с pi и bootstrap-промптом. kind=rpc: conductor поднимет `pi --mode rpc` (model, cwd опциональны). Разрешено несколько агентов на роль (для параллельных задач).",
		parameters: Type.Object({
			name: Type.String({ description: "Имя агента" }),
			role: Type.String({ description: "Роль: worker | planner | judge" }),
			kind: Type.Optional(Type.Union([Type.Literal("tmux"), Type.Literal("tmux-auto"), Type.Literal("rpc")], { description: "default: tmux; tmux-auto = conductor сам откроет панель с pi" })),
			pane: Type.Optional(Type.String({ description: "tmux-панель, например %12 (kind=tmux)" })),
			model: Type.Optional(Type.String({ description: "модель (kind=rpc)" })),
			cwd: Type.Optional(Type.String({ description: "рабочий каталог (kind=rpc; default: каталог проекта)" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const role = p.role as Role;
			if (!ROLES.includes(role)) return text(`Неизвестная роль «${p.role}». Допустимо: ${ROLES.join(", ")}.`);
			const kind = p.kind ?? "tmux";
			let surface: Agent["surface"];
			if (kind === "tmux") {
				if (!p.pane) return text("Для kind=tmux нужен pane (например %12).");
				if (!tmuxAlive(p.pane)) return text(`Панель ${p.pane} не найдена (tmux list-panes: проверь номер).`);
				surface = { kind: "tmux", target: p.pane };
			} else if (kind === "tmux-auto") {
				const source = process.env.TMUX_PANE;
				if (!source) return text("tmux-auto: pi не запущен внутри tmux (нет $TMUX_PANE). Возьми kind=tmux (свою панель) или kind=rpc.");
				try {
					const boot = `[pipeline] Ты агент ${p.name} в pipeline, роль: ${role}. Прочитай ${ensureProtocol(cwd)} (раздел «${role}» + общие правила + §Q&A) и ответь одним словом «готов». Задачи будут приходить как [pipeline T-... R-n → ${role}].`;
					const pane = createPane(source, `pi '${boot}'`);
					surface = { kind: "tmux", target: pane };
				} catch (e) {
					return text(`Не удалось открыть панель: ${(e as Error).message}`);
				}
			} else {
				try {
					rpcAgents.get(p.name)?.kill();
					rpcAgents.set(p.name, new RpcAgent({ cwd: p.cwd ?? cwd, model: p.model }));
				} catch (e) {
					return text(`Не удалось поднять rpc-процесс: ${(e as Error).message}. Проверь, что \`pi\` в PATH.`);
				}
				surface = { kind: "rpc", model: p.model, cwd: p.cwd ?? cwd };
			}
			const reg = loadRegistry(cwd);
			reg.agents = reg.agents.filter((a) => a.name !== p.name);
			reg.agents.push({ name: p.name, role, surface });
			saveRegistry(cwd, reg);
			const proto = ensureProtocol(cwd);
			const line = `[pipeline] Ты агент ${p.name} в pipeline, роль: ${role}. Прочитай ${proto} (раздел «${role}» + общие правила + §Q&A) и ответь одним словом «готов». Задачи будут приходить как [pipeline T-... R-n → ${role}].`;
			// tmux-auto: bootstrap уже ушёл стартовым промптом панели, повторно не шлём
			if (kind === "tmux") sendLine(p.pane!, line);
			else rpcAgents.get(p.name)?.prompt(line);
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
		description: "Список зарегистрированных pipeline-агентов: роль, транспорт, живость; активные задачи и занятость.",
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
			const targets = p.id ? [readState(cwd, p.id)].filter((t): t is TaskState => !!t) : findActiveTasks(cwd);
			if (!targets.length) return text(p.id ? `Задача ${p.id} не найдена или не активна.` : "Активных задач нет.");
			for (const t of targets) {
				fs.writeFileSync(path.join(t.dir, ".abort"), ""); // крутящийся runTask видит по файлу
				t.stage = "aborted";
				saveState(t);
			}
			return text(`Aborted: ${targets.map((t) => t.id).join(", ")}. Агенты доделают текущий этап, цикл не продолжится.`);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("pipeline_abort ")) + theme.fg("muted", args.id ?? "все активные"));
		},
	});
}
