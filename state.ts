/**
 * State machine pipeline: worker → planner → judge → (pass | revise+loop | blocked | max_rounds | cycle).
 * Сигнал готовности этапа = done-файл (часть протокола, а не транспорта).
 */
import fs from "node:fs";
import path from "node:path";
import { isAlive, sendLine } from "./tmux.ts";

export type Role = "worker" | "planner" | "judge";
export const ROLES: Role[] = ["worker", "planner", "judge"];

export interface Issue {
	id: string;
	sev: string;
	what: string;
	file?: string;
	how?: string;
	spec?: string;
}
export interface RoundRecord {
	round: number;
	verdict: string;
	issues: Issue[];
	notes?: string;
}
export interface TaskState {
	id: string;
	dir: string;
	base_head: string | null;
	round: number;
	stage: "worker" | "planner" | "judge" | "done" | "escalated" | "aborted";
	max_rounds: number;
	history: RoundRecord[];
	notes?: string;
	started_at: string;
}
export interface Agent {
	name: string;
	role: Role;
	pane: string;
}

export const PIPELINE_DIR = (cwd: string) => path.join(cwd, ".pi", "pipeline");

const STATE_FILE = "state.json";
const POLL_MS = 1500;
const STAGE_TIMEOUT_MS = 45 * 60_000; // агентский этап может быть долгим
const FIX_TIMEOUT_MS = 10 * 60_000; // «перезапиши verdict» — короткий

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function saveState(task: TaskState): void {
	fs.writeFileSync(path.join(task.dir, STATE_FILE), JSON.stringify(task, null, 2));
}

export function findActiveTask(cwd: string): TaskState | null {
	const root = PIPELINE_DIR(cwd);
	if (!fs.existsSync(root)) return null;
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("T-")) continue;
		const sf = path.join(root, e.name, STATE_FILE);
		if (!fs.existsSync(sf)) continue;
		try {
			const s = JSON.parse(fs.readFileSync(sf, "utf8")) as TaskState;
			if (s.stage === "worker" || s.stage === "planner" || s.stage === "judge") return s;
		} catch {
			// битый state — пропускаем
		}
	}
	return null;
}

export function taskHistory(cwd: string): TaskState[] {
	const root = PIPELINE_DIR(cwd);
	if (!fs.existsSync(root)) return [];
	const out: TaskState[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("T-")) continue;
		const sf = path.join(root, e.name, STATE_FILE);
		if (!fs.existsSync(sf)) continue;
		try {
			out.push(JSON.parse(fs.readFileSync(sf, "utf8")) as TaskState);
		} catch {}
	}
	return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Контент brief-файла для роли в текущем раунде. Только абсолютные пути. */
export function buildBrief(task: TaskState, role: Role): string {
	const d = task.dir;
	const r = `round-${task.round}`;
	const rd = path.join(d, r);
	const proto = path.join(PIPELINE_DIR(path.dirname(d)), "PROTOCOL.md");
	const common = [
		`Задача из pipeline-цепочки worker→planner→judge. Полные контракты и шаблоны: ${proto} (раздел «${role}»).`,
		"Работай автономно, без вопросов пользователю. Вопросы — в свой артефакт.",
	];
	if (role === "worker") {
		const prev =
			task.round > 1
				? `Требования к этому раунду: ${path.join(d, `round-${task.round - 1}`, "planner-decision.md")} (пункты R*).\nЗамечания судьи (исправить): ${path.join(d, `round-${task.round - 1}`, "judge-verdict.json")}.`
				: "Первый раунд: реализуй spec.";
		return [
			...common,
			`Spec: ${path.join(d, "spec.md")}`,
			prev,
			"Выход:",
			"1) изменения в коде",
			`2) отчёт: ${path.join(rd, "worker-report.md")} — шаблон PROTOCOL.md §worker`,
			`3) ФИНАЛЬНЫЙ ШАГ (обязателен): создать файл ${path.join(rd, "done-worker")}`,
		].join("\n");
	}
	if (role === "planner") {
		const reports = Array.from({ length: task.round }, (_, i) => path.join(d, `round-${i + 1}`, "worker-report.md")).join("\n");
		const verdict =
			task.round > 1 ? `\nЗамечания судьи к раунду ${task.round - 1} (переведи issues в R-требования): ${path.join(d, `round-${task.round - 1}`, "judge-verdict.json")}` : "";
		return [
			...common,
			`Spec: ${path.join(d, "spec.md")}`,
			`Отчёты работника (все раунды):\n${reports}${verdict}`,
			"Ты не правит код (read-only).",
			"Выход:",
			`1) решение: ${path.join(rd, "planner-decision.md")} — шаблон PROTOCOL.md §planner`,
			`2) ФИНАЛЬНЫЙ ШАГ (обязателен): создать файл ${path.join(rd, "done-planner")}`,
		].join("\n");
	}
	const diff = task.base_head
		? `git diff ${task.base_head} (плюс незакоммиченное: git diff)`
		: "git diff + git status (незакоммиченные изменения)";
	return [
		...common,
		`Spec (критерии приёмки, референсы, правила, границы): ${path.join(d, "spec.md")}`,
		`Результат работы, который оцениваешь: ${diff}. Оцени код и spec — НИЧЕГО больше.`,
		"Ты НЕ читаешь и не учитываешь отчёты, обоснования и переписку агентов (read-only).",
		"Выход:",
		`1) вердикт: ${path.join(rd, "judge-verdict.json")} — валидный JSON, шаблон PROTOCOL.md §judge`,
		`2) ФИНАЛЬНЫЙ ШАГ (обязателен): создать файл ${path.join(rd, "done-judge")}`,
	].join("\n");
}

export function issueKey(i: Issue): string {
	return `${i.file ?? ""}|${String(i.what ?? "").trim().slice(0, 60)}`;
}

/** Зацикливание: findings текущего и прошлого раунда почти совпадают. */
export function isCycle(prev: Issue[], curr: Issue[]): boolean {
	if (!prev.length || !curr.length) return false;
	const a = new Set(prev.map(issueKey));
	const hit = curr.map(issueKey).filter((k) => a.has(k)).length;
	return hit / Math.max(a.size, curr.length) > 0.5;
}

export function parseVerdict(file: string): { verdict: string; issues: Issue[]; notes?: string } | null {
	try {
		const v = JSON.parse(fs.readFileSync(file, "utf8"));
		if (["pass", "revise", "blocked"].includes(v.verdict) && Array.isArray(v.issues)) return v;
	} catch {}
	return null;
}

async function waitForFile(file: string, timeoutMs: number, isAborted: () => boolean): Promise<"ok" | "timeout" | "aborted"> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (isAborted()) return "aborted";
		if (fs.existsSync(file)) return "ok";
		await sleep(POLL_MS);
	}
	return "timeout";
}

async function waitForVerdict(file: string, timeoutMs: number, isAborted: () => boolean) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (isAborted()) return null;
		const v = parseVerdict(file);
		if (v) return v;
		await sleep(POLL_MS);
	}
	return null;
}

export interface LoopDeps {
	agents: Agent[];
	notify: (text: string) => void;
}

/** Полный цикл задачи. Fire-and-forget: вызывается из pipeline_run, результат — через notify. */
export async function runTask(task: TaskState, deps: LoopDeps): Promise<void> {
	const { agents, notify } = deps;
	const agentFor = (role: Role) => agents.find((a) => a.role === role);
	const aborted = () => task.stage === "aborted";
	const escalate = (reason: string) => {
		task.stage = "escalated";
		task.notes = reason;
		saveState(task);
		notify(`[commander] ${task.id}: ESCALATION — ${reason}. Состояние: ${path.join(task.dir, "state.json")}`);
	};

	while (!aborted()) {
		// Три фиксированных шага раунда
		for (const role of ROLES) {
			if (aborted()) return;
			task.stage = role;
			saveState(task);
			const agent = agentFor(role);
			if (!agent) return escalate(`нет зарегистрированного агента с ролью ${role}`);
			if (!isAlive(agent.pane)) return escalate(`агент ${agent.name} (${role}): пань ${agent.pane} не жив`);

			const rd = path.join(task.dir, `round-${task.round}`);
			fs.mkdirSync(rd, { recursive: true });
			const marker = path.join(rd, `done-${role}`);

			fs.writeFileSync(path.join(rd, `brief-${role}.md`), buildBrief(task, role));
			sendLine(agent.pane, `[pipeline ${task.id} R${task.round} → ${role}] Прочитай ${path.join(rd, `brief-${role}.md`)} и выполни, включая финальный шаг.`);

			const w = await waitForFile(marker, STAGE_TIMEOUT_MS, aborted);
			if (w === "aborted") return;
			if (w === "timeout") return escalate(`таймаут ${STAGE_TIMEOUT_MS / 60000} мин: ${agent.name} не сделал финальный шаг (${path.basename(marker)})`);

			if (role === "judge") {
				const vf = path.join(rd, "judge-verdict.json");
				let v = parseVerdict(vf) ?? (await waitForVerdict(vf, FIX_TIMEOUT_MS, aborted));
				if (!v) {
					// один запрос на переписывание, повторное ожидание
					sendLine(agent.pane, `[pipeline ${task.id}] ${vf} невалидный JSON. Перезапиши по шаблону PROTOCOL.md §judge (verdict + issues).`);
					v = await waitForVerdict(vf, FIX_TIMEOUT_MS, aborted);
					if (!v) return escalate("судья не выдал валидный judge-verdict.json после повторного запроса");
				}
				task.history.push({ round: task.round, verdict: v.verdict, issues: v.issues, notes: v.notes });
				saveState(task);
				if (v.verdict === "pass") {
					task.stage = "done";
					saveState(task);
					notify(`[commander] ${task.id}: PASS за ${task.round} раунд(ов).${v.notes ? ` Notes: ${v.notes}` : ""} История: ${task.dir}`);
					return;
				}
				if (v.verdict === "blocked") {
					return escalate(`judge: blocked — ${v.notes ?? "не может оценить (spec противоречив?)"}`);
				}
				const prevIssues = task.history.length > 1 ? task.history[task.history.length - 2].issues : [];
				if (isCycle(prevIssues, v.issues)) {
					return escalate("зацикливание: findings раунда и предыдущего почти совпадают (прогресса нет)");
				}
				if (task.round >= task.max_rounds) {
					return escalate(`max_rounds (${task.max_rounds}) исчерпан, последний вердикт: revise`);
				}
				task.round++;
				saveState(task);
			}
		}
	}
	notify(`[commander] ${task.id}: aborted (остановлен пользователем).`);
}
