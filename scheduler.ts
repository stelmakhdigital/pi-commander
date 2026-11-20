/**
 * Планировщик: разбор набора агентов, конфликт-чек, запуск runTask и FIFO-очередь.
 * Вынесено из index.ts и построено на инъекции: transport (pool) и уведомления —
 * фейки в тестах, без tmux и живых rpc-процессов.
 */
import { loadRegistry } from "./registry.ts";
import {
	ROLES,
	findClaimingTasks,
	findQueuedTasks,
	runTask,
	type Agent,
	type LoopDeps,
	type Slice,
	type TaskState,
surfaceStr,
} from "./state.ts";

/** Транспортный пул проводника (в index.ts — обёртка над tmux + RpcAgent-картой). */
export interface AgentPool {
	/** подготовить агента к проверке живости/отправке (для rpc — lazy auto-respawn) */
	ensure(a: Agent, cwd: string): void;
	alive(a: Agent): boolean;
	sendTo(a: Agent, line: string, cwd: string): void;
	/** slice-воркер в worktree (слайсы conductor поднимает сам) */
	spawnSliceWorker(task: TaskState, s: Slice, wt: string, model?: string): Promise<Agent>;
	killAgent(a: Agent): void;
}

export function resolveAgents(pool: AgentPool, cwd: string, sel?: { worker?: string; planner?: string; judge?: string }): { agents: Agent[]; problems: string[] } {
	const reg = loadRegistry(cwd);
	const problems: string[] = [];
	const agents: Agent[] = [];
	for (const r of ROLES) {
		const name = sel?.[r];
		const a = name ? reg.agents.find((x) => x.name === name) : reg.agents.find((x) => x.role === r);
		if (a && a.surface.kind === "rpc") pool.ensure(a, cwd);
		if (!a) {
			problems.push(name ? `агент «${name}» не найден в реестре (роль ${r})` : `нет агента с ролью ${r} (pipeline_register)`);
			continue;
		}
		if (!pool.alive(a)) {
			problems.push(`агент ${a.name} (${r}, ${surfaceStr(a)}): не жив`);
			continue;
		}
		agents.push(a);
	}
	return { agents, problems };
}

/** Конфликт-чек: агент уже занят в другой задаче (активной или в очереди). */
export function busyAgents(cwd: string, exceptId?: string): Map<string, string> {
	const busy = new Map<string, string>();
	for (const t of findClaimingTasks(cwd)) {
		if (t.id === exceptId) continue;
		for (const [r, name] of Object.entries(t.agents ?? {})) if (name) busy.set(name, `${t.id} (${r})`);
	}
	return busy;
}

/** Единая сборка LoopDeps (прямой запуск и очередь). */
export function makeDeps(task: TaskState, agents: Agent[], pool: AgentPool, notify: (t: string) => void): LoopDeps {
	return {
		agents,
		sendTo: (a, l) => pool.sendTo(a, l, task.cwd),
		alive: (a) => pool.alive(a),
		notify,
		spawnSliceWorker: async (_t, s: Slice, wt: string) => {
			const worker = agents.find((a) => a.role === "worker");
			const model = worker && worker.surface.kind === "rpc" ? worker.surface.model : undefined;
			return pool.spawnSliceWorker(task, s, wt, model);
		},
		killAgent: (a) => pool.killAgent(a),
	};
}

export interface SchedulerDeps {
	cwd: string;
	pool: AgentPool;
	/** уже запущенные в этом процессе id (не запускать дважды) */
	launched: Set<string>;
	notify: (t: string) => void;
	/** эскалация вне runTask (файл + состояние + уведомление) */
	escalate: (t: TaskState, reason: string) => void;
}

/** Один проход очереди: queued-задача стартует, когда её набор агентов свободен (FIFO). */
export function tickQueue(d: SchedulerDeps): void {
	try {
		for (const t of findQueuedTasks(d.cwd)) {
			if (d.launched.has(t.id)) continue;
			const { agents, problems } = resolveAgents(d.pool, d.cwd, t.agents);
			if (problems.length) {
				d.escalate(t, `очередь: ${problems.join("; ")}`);
				continue;
			}
			if (t.mode === "sliced") {
				const w = agents.find((a) => a.role === "worker");
				if (!w || w.surface.kind !== "rpc") {
					d.escalate(t, "очередь: sliced-задача требует rpc-воркера");
					continue;
				}
			}
			const busy = busyAgents(d.cwd, t.id);
			if (agents.some((a) => busy.has(a.name))) continue; // ещё заняты — ждём
			d.launched.add(t.id);
			runTask(t, makeDeps(t, agents, d.pool, d.notify)).catch((err) => d.notify(`[commander] ${t.id}: ОШИБКА: ${(err as Error)?.message ?? err}`));
		}
	} catch (e) {
		d.notify(`[commander] очередь: ошибка: ${(e as Error).message ?? e}`);
	}
}

/** Запуск задачи: mark-launched + runTask с общими deps (прямой старт из pipeline_run). */
export function launchTask(task: TaskState, agents: Agent[], pool: AgentPool, notify: (t: string) => void, launched: Set<string>): void {
	launched.add(task.id);
	runTask(task, makeDeps(task, agents, pool, notify)).catch((err) => notify(`[commander] ${task.id}: ОШИБКА: ${(err as Error)?.message ?? err}`));
}
