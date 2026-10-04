/**
 * commander — оркестрация зарегистрированных pi-агентов (tmux-пани) в цепочку
 * worker → planner → judge с loop'ом по вердикту судьи.
 * Conductor детерминирован (без LLM); LLM — только внутри агентов.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { PIPELINE_DIR, ROLES, findActiveTask, runTask, saveState, taskHistory, type Role, type TaskState } from "./state.ts";
import { isAlive, sendLine } from "./tmux.ts";
import { PROTOCOL } from "./protocol.ts";

export default function commander(pi: ExtensionAPI) {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

	const problems = (cwd: string): string[] => {
		const reg = loadRegistry(cwd);
		return ROLES.flatMap((r) => {
			const a = reg.agents.find((x) => x.role === r);
			if (!a) return [`нет агента с ролью ${r} (pipeline_register)`];
			if (!isAlive(a.pane)) return [`агент ${a.name} (${r}): пань ${a.pane} не жив`];
			return [];
		});
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

	pi.registerTool({
		name: "pipeline_run",
		label: "pipeline_run",
		description:
			"Запустить pipeline-цепочку worker→planner→judge. spec — путь к spec.md или сам текст задачи (обязателен раздел «Критерии приёмки»). Все три роли должны быть зарегистрированы (pipeline_register). Loop идёт фоном, результат придёт сообщением.",
		parameters: Type.Object({
			spec: Type.String({ description: "Путь к spec.md или текст задачи" }),
			max_rounds: Type.Optional(Type.Number({ description: "Максимум раундов (default 3)" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			if (findActiveTask(cwd)) return text("Уже есть активный pipeline. pipeline_status — прогресс, pipeline_abort — остановка.");
			const prob = problems(cwd);
			if (prob.length) return text("Pipeline не запущен:\n- " + prob.join("\n- ") + "\nЗарегистрируй агентов: pipeline_register.");

			let specText: string;
			if (fs.existsSync(p.spec) && fs.statSync(p.spec).isFile()) specText = fs.readFileSync(p.spec, "utf8");
			else specText = p.spec;
			if (!/критерии приёмки/i.test(specText))
				return text("В spec нет раздела «Критерии приёмки» — судье нечем сверять. Шаблон: PROTOCOL.md §spec. Добавь и запусти заново.");

			const root = PIPELINE_DIR(cwd);
			ensureProtocol(cwd);
			const id = `T-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
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
				started_at: new Date().toISOString(),
			};
			fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(task, null, 2));

			const reg = loadRegistry(cwd);
			runTask(task, { agents: reg.agents, notify }).catch((err) => notify(`[commander] ${id}: ОШИБКА: ${(err as Error)?.message ?? err}`));

			const who = ROLES.map((r) => `${r}=${reg.agents.find((a) => a.role === r)!.name}(${reg.agents.find((a) => a.role === r)!.pane})`).join(", ");
			return text(`${id} запущен: round 1 → worker. Агенты: ${who}. Прогресс: pipeline_status. Результат придёт сообщением.`);
		},
	});

	pi.registerTool({
		name: "pipeline_status",
		label: "pipeline_status",
		description: "Статус активного pipeline: стадия, раунд, история вердиктов, артефакты. Без аргументов — активная задача; id — конкретная.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "id задачи (T-...), по умолчанию активная" })),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const root = PIPELINE_DIR(cwd);
			let task: TaskState | null = null;
			if (p.id) {
				const sf = path.join(root, p.id, "state.json");
				task = fs.existsSync(sf) ? (JSON.parse(fs.readFileSync(sf, "utf8")) as TaskState) : null;
			} else {
				task = findActiveTask(cwd);
			}
			if (!task) {
				const hist = taskHistory(cwd).slice(-3).map((t) => `${t.id} [${t.stage}] ${t.notes ?? ""}`);
				return text("Активного pipeline нет." + (hist.length ? " Последние:\n" + hist.join("\n") : ""));
			}
			const lines = [`${task.id}: stage=${task.stage} round=${task.round}/${task.max_rounds}`];
			if (task.notes) lines.push(`notes: ${task.notes}`);
			for (const h of task.history) lines.push(`round ${h.round}: ${h.verdict}${h.issues.length ? ` (${h.issues.length} issues)` : ""}${h.notes ? ` — ${h.notes}` : ""}`);
			for (const e of fs.existsSync(task.dir) ? fs.readdirSync(task.dir, { withFileTypes: true }) : []) {
				if (e.name === "round-1" && !e.isDirectory()) continue;
				if (e.isDirectory() && e.name.startsWith("round-")) {
					const files = fs.readdirSync(path.join(task.dir, e.name));
					lines.push(`${e.name}: ${files.join(", ") || "—"}`);
				}
			}
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "pipeline_register",
		label: "pipeline_register",
		description: "Зарегистрировать живую pi-сессию (tmux-пань) в pipeline-реестре на роль worker|planner|judge и отправить ей bootstrap. Одна роль — один агент.",
		parameters: Type.Object({
			name: Type.String({ description: "Имя агента (как ты его будешь называть)" }),
			pane: Type.String({ description: "tmux-пань (например %12)" }),
			role: Type.String({ description: "Роль: worker | planner | judge" }),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const role = p.role as Role;
			if (!ROLES.includes(role)) return text(`Неизвестная роль «${p.role}». Допустимо: ${ROLES.join(", ")}.`);
			if (!isAlive(p.pane)) return text(`Пань ${p.pane} не найден (tmux list-panes: проверь номер).`);
			const reg = loadRegistry(cwd);
			const dupRole = reg.agents.find((a) => a.role === role && a.name !== p.name);
			if (dupRole) return text(`Роль ${role} уже занята: ${dupRole.name} (${dupRole.pane}). Сначала удали его из .pi/pipeline/registry.json.`);
			reg.agents = reg.agents.filter((a) => a.name !== p.name);
			reg.agents.push({ name: p.name, role, pane: p.pane });
			saveRegistry(cwd, reg);
			const proto = ensureProtocol(cwd);
			sendLine(p.pane, `[pipeline] Ты агент ${p.name} в pipeline, роль: ${role}. Прочитай ${proto} (раздел «${role}» + общие правила) и ответь одним словом «готов». Задачи будут приходить как [pipeline T-... R-n → ${role}].`);
			return text(`Зарегистрирован: ${p.name} (${role}, ${p.pane}). Bootstrap отправлен — проверь пань на ответ «готов».`);
		},
	});

	pi.registerTool({
		name: "pipeline_agents",
		label: "pipeline_agents",
		description: "Список зарегистрированных pipeline-агентов с живостью пней и активной задачей.",
		parameters: Type.Object({}),
		async execute(_id, _p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const reg = loadRegistry(cwd);
			if (!reg.agents.length) return text("Никто не зарегистрирован. pipeline_register name=... pane=... role=...");
			const lines = reg.agents.map((a) => `${a.name} — ${a.role}, ${a.pane} ${isAlive(a.pane) ? "✓" : "✗ МЁРТВ"}`);
			const active = findActiveTask(cwd);
			lines.push(active ? `активна: ${active.id} [${active.stage}] round ${active.round}` : "активной задачи нет");
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "pipeline_send",
		label: "pipeline_send",
		description: "Отправить одну строку зарегистрированному pipeline-агенту (отладка, ручная помощь, ad-hoc). Не часть chain-протокола.",
		parameters: Type.Object({
			name: Type.String({ description: "Имя агента из реестра" }),
			message: Type.String({ description: "Одна строка сообщения" }),
		}),
		async execute(_id, p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const a = loadRegistry(cwd).agents.find((x) => x.name === p.name);
			if (!a) return text(`Агент «${p.name}» не найден в реестре.`);
			if (!isAlive(a.pane)) return text(`Пань ${a.pane} не жив.`);
			sendLine(a.pane, p.message);
			return text(`Отправлено в ${p.name} (${a.pane}).`);
		},
	});

	pi.registerTool({
		name: "pipeline_abort",
		label: "pipeline_abort",
		description: "Остановить активный pipeline (state → aborted; текущий этап агента не прерывается, но цикл не продолжится).",
		parameters: Type.Object({}),
		async execute(_id, _p, _signal, _u, ctx) {
			const cwd = ctx.cwd || process.cwd();
			const task = findActiveTask(cwd);
			if (!task) return text("Активного pipeline нет.");
			task.stage = "aborted";
			saveState(task);
			return text(`${task.id}: aborted. Агент, работавший на текущем этапе, доделает дело, но цикл не продолжится.`);
		},
	});
}
