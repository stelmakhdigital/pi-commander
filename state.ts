/**
 * State machine pipeline: worker → planner → judge → (pass | revise+loop | blocked | max_rounds | cycle).
 * Сигнал готовности этапа = done-файл (часть протокола, а не транспорта).
 * Mid-round Q&A: worker пишет ask-файл → conductor ретранслирует planner'у → ответы → worker.
 * Параллельные задачи: у каждой задачи свой набор агентов (TaskState.agents).
 */
import fs from "node:fs";
import path from "node:path";

export type Role = "worker" | "planner" | "judge";
export const ROLES: Role[] = ["worker", "planner", "judge"];

/** Где живёт агент: tmux-пань (чужая живая сессия) или RPC-процесс под управлением conductor'а. */
export type Surface =
	| { kind: "tmux"; target: string }
	| { kind: "rpc"; model?: string; cwd?: string };

export interface Agent {
	name: string;
	role: Role;
	surface: Surface;
}
/** Миграция старого формата реестра ({ pane: "%12" }) в surface. */
export function normalizeAgent(raw: Record<string, unknown>): Agent | null {
	const name = typeof raw.name === "string" ? raw.name : null;
	const role = typeof raw.role === "string" ? raw.role : null;
	if (!name || !ROLES.includes(role as Role)) return null;
	if (raw.surface && typeof raw.surface === "object") return { name, role: role as Role, surface: raw.surface as Surface };
	if (typeof raw.pane === "string") return { name, role: role as Role, surface: { kind: "tmux", target: raw.pane } };
	return null;
}

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
	/** Имена агентов, занятых задачей (параллельные задачи). Старые состояния — без поля. */
	agents?: Partial<Record<Role, string>>;
	notes?: string;
	started_at: string;
}

export const PIPELINE_DIR = (cwd: string) => path.join(cwd, ".pi", "pipeline");

const STATE_FILE = "state.json";
const POLL_MS = 1500;
const STAGE_TIMEOUT_MS = 45 * 60_000; // агентский этап может быть долгим
const FIX_TIMEOUT_MS = 10 * 60_000; // «перезапиши verdict» — короткий
const QA_TIMEOUT_MS = 15 * 60_000; // ответ planner'а на mid-round вопросы
export const MAX_QA_PER_STAGE = 3; // worker не должен зациклиться на вопросах

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function saveState(task: TaskState): void {
	fs.writeFileSync(path.join(task.dir, STATE_FILE), JSON.stringify(task, null, 2));
}

export function readState(cwd: string, id: string): TaskState | null {
	const sf = path.join(PIPELINE_DIR(cwd), id, STATE_FILE);
	if (!fs.existsSync(sf)) return null;
	try {
		return JSON.parse(fs.readFileSync(sf, "utf8")) as TaskState;
	} catch {
		return null;
	}
}

const isActive = (s: TaskState) => s.stage === "worker" || s.stage === "planner" || s.stage === "judge";

/** Все задачи (для параллельного запуска: конфликт-чек по занятым агентам). */
export function findActiveTasks(cwd: string): TaskState[] {
	const root = PIPELINE_DIR(cwd);
	if (!fs.existsSync(root)) return [];
	const out: TaskState[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("T-")) continue;
		const s = readState(cwd, e.name);
		if (s && isActive(s)) out.push(s);
	}
	return out;
}

export function taskHistory(cwd: string): TaskState[] {
	const root = PIPELINE_DIR(cwd);
	if (!fs.existsSync(root)) return [];
	const out: TaskState[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("T-")) continue;
		const s = readState(cwd, e.name);
		if (s) out.push(s);
	}
	return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Контент brief-файла для роли в текущем раунде. Только абсолютные пути. */
export function buildBrief(task: TaskState, role: Role): string {
	const d = task.dir;
	const rd = path.join(d, `round-${task.round}`);
	const proto = path.join(path.dirname(d), "PROTOCOL.md");
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
			`Если не можешь продолжить без решения архитектора — НЕ гадай: напиши вопросы в ${path.join(rd, "ask-worker.md")} (нумерованные, самодостаточные) и продолжай после ответа, который придёт сообщением [pipeline ... → worker]. См. PROTOCOL.md §Q&A.`,
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
			`Могут прийти mid-round сообщения «→ planner Q&A» — ответы на них: по PROTOCOL.md §Q&A, в указанный в сообщении файл.`,
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

export interface StageResult {
	ok: boolean;
	reason: "ok" | "timeout" | "aborted" | "qa-loop" | "no-planner" | "qa-timeout";
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
	sendTo: (agent: Agent, line: string) => void | Promise<void>;
	alive: (agent: Agent) => boolean;
	notify: (text: string) => void;
}

/**
 * Ожидание этапа: done-маркер, либо (worker) mid-round Q&A.
 * Q&A: worker пишет ask-worker.md → conductor переименовывает в ask-worker-<k>.md,
 * шлёт planner'у, ждёт answered-<k>, пересылает worker'у answers-<k>.md.
 */
export async function waitForStage(task: TaskState, role: Role, rd: string, deps: LoopDeps): Promise<StageResult> {
	const aborted = () => task.stage === "aborted";
	const marker = path.join(rd, `done-${role}`);
	const askBase = path.join(rd, "ask-worker.md");
	const worker = deps.agents.find((a) => a.role === "worker");
	let qa = 0;
	const t0 = Date.now();
	while (Date.now() - t0 < STAGE_TIMEOUT_MS) {
		if (aborted()) return { ok: false, reason: "aborted" };
		if (fs.existsSync(marker)) return { ok: true, reason: "ok" };
		if (role === "worker" && fs.existsSync(askBase)) {
			qa++;
			if (qa > MAX_QA_PER_STAGE) return { ok: false, reason: "qa-loop" };
			const k = qa;
			const ask = path.join(rd, `ask-worker-${k}.md`);
			const answers = path.join(rd, `answers-${k}.md`);
			const doneQa = path.join(rd, `answered-${k}`);
			fs.renameSync(askBase, ask);
			const planner = deps.agents.find((a) => a.role === "planner");
			if (!planner || !deps.alive(planner)) return { ok: false, reason: "no-planner" };
			await deps.sendTo(
				planner,
				`[pipeline ${task.id} R${task.round} → planner Q&A] Worker ждёт решения. Вопросы: ${ask}. Ответь на каждый пункт (read-only, код не трогай), запиши в ${answers} и сделай финальный шаг: создать ${doneQa}.`,
			);
			const wq = await waitForFile(doneQa, QA_TIMEOUT_MS, aborted);
			if (wq !== "ok") return { ok: false, reason: wq === "aborted" ? "aborted" : "qa-timeout" };
			if (worker) await deps.sendTo(worker, `[pipeline ${task.id} R${task.round} → worker] Ответы архитектора: ${answers}. Продолжи задачу, финальный шаг без изменений.`);
		}
		await sleep(POLL_MS);
	}
	return { ok: false, reason: "timeout" };
}

/** Полный цикл задачи. Fire-and-forget: вызывается из pipeline_run, результат — через notify. */
export async function runTask(task: TaskState, deps: LoopDeps): Promise<void> {
	const { agents, sendTo, alive, notify } = deps;
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
			if (!agent) return escalate(`нет агента с ролью ${role} в наборе задачи`);
			if (!alive(agent)) return escalate(`агент ${agent.name} (${role}): мёртв`);

			const rd = path.join(task.dir, `round-${task.round}`);
			fs.mkdirSync(rd, { recursive: true });

			fs.writeFileSync(path.join(rd, `brief-${role}.md`), buildBrief(task, role));
			await sendTo(agent, `[pipeline ${task.id} R${task.round} → ${role}] Прочитай ${path.join(rd, `brief-${role}.md`)} и выполни, включая финальный шаг.`);

			let w: StageResult;
			if (role === "worker") w = await waitForStage(task, role, rd, deps);
			else {
				const r = await waitForFile(path.join(rd, `done-${role}`), STAGE_TIMEOUT_MS, aborted);
				w = { ok: r === "ok", reason: r };
			}
			if (!w.ok) {
				if (w.reason === "aborted") return;
				const reasons: Record<string, string> = {
					timeout: `таймаут ${STAGE_TIMEOUT_MS / 60000} мин: ${agent.name} не сделал финальный шаг (done-${role})`,
					"qa-loop": `worker зациклится на вопросах (> ${MAX_QA_PER_STAGE} Q&A за этап)`,
					"no-planner": "worker ждёт ответа, но planner недоступен",
					"qa-timeout": `таймаут ${QA_TIMEOUT_MS / 60000} мин: planner не ответил на mid-round вопросы`,
				};
				return escalate(reasons[w.reason]);
			}

			if (role === "judge") {
				const vf = path.join(rd, "judge-verdict.json");
				let v = parseVerdict(vf) ?? (await waitForVerdict(vf, FIX_TIMEOUT_MS, aborted));
				if (!v) {
					// один запрос на переписывание, повторное ожидание
					await sendTo(agent, `[pipeline ${task.id}] ${vf} невалидный JSON. Перезапиши по шаблону PROTOCOL.md §judge (verdict + issues).`);
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
