/**
 * State machine pipeline: worker → planner → judge → (pass | revise+loop | blocked | max_rounds | cycle).
 * Сигнал готовности этапа = done-файл (часть протокола, а не транспорта).
 * Mid-round Q&A: worker пишет ask-файл → conductor ретранслирует planner'у → ответы → worker.
 * Параллельные задачи: у каждой задачи свой набор агентов (TaskState.agents);
 * занятые агенты не отменяют запуск — задача встаёт в очередь (stage "queued").
 * Параллелизм внутри раунда: planner и judge не зависят друг от друга и работают одновременно.
 * Sliced-режим (fan-out): round 1 = decompose (planner) → N worker'ов в git worktrees
 * параллельно → merge → planner∥judge. Раунды 2+ — обычные (один worker).
 */
import fs from "node:fs";
import path from "node:path";
import { branchDelete, commitAll, merge, sliceBranch, worktreeAdd, worktreeRemove } from "./git.ts";

export type Role = "worker" | "planner" | "judge";
export const ROLES: Role[] = ["worker", "planner", "judge"];

/** Где живёт агент: tmux-панель (чужая живая сессия) или RPC-процесс под управлением conductor'а. */
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
	/** Корень репо/проекта, где работает pipeline (для git и brief'ов). */
	cwd: string;
	round: number;
	stage: "queued" | "worker" | "planner" | "judge" | "done" | "escalated" | "aborted";
	max_rounds: number;
	history: RoundRecord[];
	/** Имена агентов, занятых задачей (параллельные задачи). Старые состояния — без поля. */
	agents?: Partial<Record<Role, string>>;
	/** "sliced" = fan-out по слайсам в worktrees (round 1), иначе обычный цикл. */
	mode?: "serial" | "sliced";
	/** Сколько слайсов (2..N) — в sliced-режиме. */
	slice_count?: number;
	notes?: string;
	started_at: string;
}

export const PIPELINE_DIR = (cwd: string) => path.join(cwd, ".pi", "pipeline");

const STATE_FILE = "state.json";
/** Файл-маркер abort: pipeline_abort пишет его, крутящийся runTask видит (in-memory stage не обновляется). */
const ABORT_FILE = ".abort";
const POLL_MS = 1500;
/** Мягкий порог: по нему работу НЕ откатываем — уведомляем и ждём, пока агент жив.
 *  Эскалация только по смерти агента (проверка живости каждые ~10 поллов). */
const STAGE_TIMEOUT_MS = 45 * 60_000;
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
		const s = JSON.parse(fs.readFileSync(sf, "utf8")) as TaskState;
		if (!s.cwd) s.cwd = path.resolve(s.dir, "..", "..", ".."); // legacy-состояния без cwd
		return s;
	} catch {
		return null;
	}
}

const isActive = (s: TaskState) => s.stage === "worker" || s.stage === "planner" || s.stage === "judge";
const isClaiming = (s: TaskState) => isActive(s) || s.stage === "queued";

/** Задачи, уже крутящиеся (рестарт-эскалация, статус). */
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

/** Задачи, претендующие на агентов (вкл. очередь) — для конфликт-чека. */
export function findClaimingTasks(cwd: string): TaskState[] {
	const root = PIPELINE_DIR(cwd);
	if (!fs.existsSync(root)) return [];
	const out: TaskState[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("T-")) continue;
		const s = readState(cwd, e.name);
		if (s && isClaiming(s)) out.push(s);
	}
	return out;
}

/** Очередь запуска: stage=queued, FIFO по времени создания. */
export function findQueuedTasks(cwd: string): TaskState[] {
	const out: TaskState[] = [];
	for (const s of findClaimingTasks(cwd)) if (s.stage === "queued") out.push(s);
	return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
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

/** Sliced-режим: слайс = независимый кусок spec для параллельного worker'а. */
export interface Slice {
	name: string;
	scope: string;
	brief: string;
}

/** Валидация slices.json: JSON-массив 2..max с name+brief. */
export function parseSlices(file: string, max: number): Slice[] | null {
	try {
		const v = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(v)) return null;
		const out = v
			.filter((s) => s && typeof s === "object" && typeof s.name === "string" && s.name && typeof s.brief === "string" && s.brief)
			.map((s) => ({ name: s.name, scope: typeof s.scope === "string" && s.scope ? s.scope : s.brief, brief: s.brief }));
		return out.length >= 2 && out.length <= max ? out : null;
	} catch {
		return null;
	}
}

/** Brief для planner'а в sliced-раунде 1: дробит spec на слайсы (read-only, до начала работ). */
export function buildDecomposeBrief(task: TaskState): string {
	const d = task.dir;
	const rd = path.join(d, `round-${task.round}`);
	const proto = path.join(path.dirname(d), "PROTOCOL.md");
	const max = task.slice_count ?? 6;
	return [
		`Задача из pipeline, sliced-режим (fan-out). Контракты: ${proto} (раздел «slices»).`,
		`Spec: ${path.join(d, "spec.md")}`,
		`Разбей реализацию spec на 2..${max} независимых слайсов — они будут работать ПАРАЛЛЕЛЬНО в изолированных git worktrees:`,
		"- слайсы НЕ пересекаются по файлам (merge-конфликт = провал задачи);",
		"- каждый слайс самодостаточен: реализуется, не зная реализации других;",
		"- общие файлы (package.json, конфиги, barrel-экспорты) — НЕ в слайсах;",
		"- каждый слайс закрывает проверяемый кусок критериев приёмки spec.",
		"Ты read-only: код не править.",
		"Выход:",
		`1) ${path.join(rd, "slices.json")} — валидный JSON: [{"name": "s1", "scope": "файлы/каталоги слайса", "brief": "что именно сделать (конкретика из spec + критерии приёмки слайса)"}]`,
		`2) ФИНАЛЬНЫЙ ШАГ (обязателен): создать файл ${path.join(rd, "done-decompose")}`,
	].join("\n");
}

/** Brief для worker'а одного слайса: свой worktree, свой отчёт, свой done-файл, обязательный commit. */
export function buildSliceBrief(task: TaskState, s: Slice, srd: string, wt: string): string {
	const d = task.dir;
	const proto = path.join(path.dirname(d), "PROTOCOL.md");
	return [
		`Задача из pipeline, sliced-режим (fan-out). Контракты: ${proto} (раздел «slices»).`,
		`Каталог работы (git worktree): ${wt}`,
		`Spec: ${path.join(d, "spec.md")}`,
		`Твой слайс: ${s.name} — ${s.scope}`,
		`Задание: ${s.brief}`,
		"Параллельно работают другие слайсы: общий код не переписывай, scope не расширяй, файлы чужих слайсов не трогай.",
		`Если не можешь продолжить без решения архитектора — напиши вопросы в ${path.join(srd, "ask-worker.md")} (нумерованные, самодостаточные), см. PROTOCOL.md §Q&A.`,
		"Выход:",
		'1) изменения в коде worktree + COMMIT всех изменений (git add -A && git commit -m "...") — без commit\'а работа не попадёт в проект',
		`2) отчёт: ${path.join(srd, "worker-report.md")} — шаблон PROTOCOL.md §worker`,
		`3) ФИНАЛЬНЫЙ ШАГ (обязателен): создать файл ${path.join(srd, "done-worker")}`,
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
	reason: "ok" | "dead" | "aborted" | "qa-loop" | "no-planner" | "qa-dead";
}

interface WaitDeps {
	label: string;
	softMs: number;
	isAborted: () => boolean;
	isAlive: () => boolean;
	notify: (t: string) => void;
}

/** Ожидание артефакта. По softMs работу не откатываем: агент жив — ждём до готовности
 *  (одно уведомление о превышении); агент умер — "dead". */
async function waitWhileAlive(ok: () => boolean, w: WaitDeps): Promise<"ok" | "aborted" | "dead"> {
	const t0 = Date.now();
	let warned = false;
	let i = 0;
	while (true) {
		if (w.isAborted()) return "aborted";
		if (ok()) return "ok";
		if (i++ % 10 === 0 && !w.isAlive()) return "dead";
		if (!warned && Date.now() - t0 >= w.softMs) {
			warned = true;
			w.notify(`[commander] ${w.label}: мягкие ${Math.round(w.softMs / 60000)} мин прошли, артефакта нет — агент работает, жду до готовности`);
		}
		await sleep(POLL_MS);
	}
}

async function waitForVerdict(file: string, w: WaitDeps) {
	const r = await waitWhileAlive(() => parseVerdict(file) !== null, w);
	return r === "ok" ? parseVerdict(file) : null;
}

export interface LoopDeps {
	agents: Agent[];
	sendTo: (agent: Agent, line: string) => void | Promise<void>;
	alive: (agent: Agent) => boolean;
	notify: (text: string) => void;
	/** Sliced-режим: conductor создал worktree (wt) — подними под него worker'а и верни Agent. */
	spawnSliceWorker?: (task: TaskState, slice: Slice, wt: string) => Promise<Agent>;
	/** Убить временного (slice) агента по завершении задачи. */
	killAgent?: (a: Agent) => void;
}

/**
 * Ожидание worker-стадии (actor — кто работает: обычный worker или slice-агент):
 * done-маркер в rd, либо mid-round Q&A.
 * Q&A: actor пишет ask-worker.md → conductor переименовывает в ask-worker-<k>.md,
 * шлёт planner'у, ждёт answered-<k>, пересылает actor'у answers-<k>.md.
 */
export async function waitForStage(task: TaskState, rd: string, deps: LoopDeps, actor: Agent): Promise<StageResult> {
	const aborted = () => fs.existsSync(path.join(task.dir, ABORT_FILE));
	const marker = path.join(rd, `done-worker`);
	const askBase = path.join(rd, "ask-worker.md");
	let qa = 0;
	let warned = false;
	let i = 0;
	const t0 = Date.now();
	while (true) {
		if (aborted()) return { ok: false, reason: "aborted" };
		if (fs.existsSync(marker)) return { ok: true, reason: "ok" };
		if (fs.existsSync(askBase)) {
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
			const wq = await waitWhileAlive(() => fs.existsSync(doneQa), {
				label: `${task.id} Q&A-${k} (planner ${planner.name})`,
				softMs: QA_TIMEOUT_MS,
				isAborted: aborted,
				isAlive: () => deps.alive(planner),
				notify: deps.notify,
			});
			if (wq !== "ok") return { ok: false, reason: wq === "aborted" ? "aborted" : "qa-dead" };
			await deps.sendTo(actor, `[pipeline ${task.id} R${task.round} → worker] Ответы архитектора: ${answers}. Продолжи задачу, финальный шаг без изменений.`);
		}
		if (i++ % 10 === 0 && !deps.alive(actor)) return { ok: false, reason: "dead" };
		if (!warned && Date.now() - t0 >= STAGE_TIMEOUT_MS) {
			warned = true;
			deps.notify(`[commander] ${task.id}: ${actor.name} не сделал финальный шаг за ${STAGE_TIMEOUT_MS / 60000} мин — работаю, жду до готовности`);
		}
		await sleep(POLL_MS);
	}
}

/** Полный цикл задачи. Fire-and-forget: вызывается из pipeline_run, результат — через notify. */
export async function runTask(task: TaskState, deps: LoopDeps): Promise<void> {
	const { agents, sendTo, alive, notify } = deps;
	const agentFor = (role: Role) => agents.find((a) => a.role === role);
	const aborted = () => fs.existsSync(path.join(task.dir, ABORT_FILE));
	const rdOf = (n: number) => path.join(task.dir, `round-${n}`);
	const escalate = (reason: string) => {
		task.stage = "escalated";
		task.notes = reason;
		saveState(task);
		notify(`[commander] ${task.id}: ESCALATION — ${reason}. Состояние: ${path.join(task.dir, "state.json")}`);
	};
	/** Временные slice-агенты (убиваются в finally) и worktrees+ветки (чистятся по pass). */
	const sliceAgents: Agent[] = [];
	const cleanups: { wt: string; branch: string }[] = [];

	const sendStage = (agent: Agent, rd: string, briefName: string, content: string) => {
		const bf = path.join(rd, briefName);
		fs.mkdirSync(rd, { recursive: true });
		fs.writeFileSync(bf, content);
		sendTo(agent, `[pipeline ${task.id} R${task.round} → ${agent.role}] Прочитай ${bf} и выполни, включая финальный шаг.`);
	};

	/** Planner: ревью + R-требования к следующему раунду. Не зависит от judge — параллельно. */
	const plannerStage = async (): Promise<StageResult> => {
		const agent = agentFor("planner");
		if (!agent) return { ok: false, reason: "no-planner" };
		if (!alive(agent)) return { ok: false, reason: "dead" };
		const rd = rdOf(task.round);
		sendStage(agent, rd, "brief-planner.md", buildBrief(task, "planner"));
		const r = await waitWhileAlive(() => fs.existsSync(path.join(rd, "done-planner")), {
			label: `${task.id} planner ${agent.name}`, softMs: STAGE_TIMEOUT_MS, isAborted: aborted, isAlive: () => alive(agent), notify,
		});
		return { ok: r === "ok", reason: r };
	};

	/** Judge: вердикт по spec+diff. Не зависит от planner — параллельно. */
	const judgeStage = async (): Promise<{ v?: { verdict: string; issues: Issue[]; notes?: string }; fail?: string }> => {
		const agent = agentFor("judge");
		if (!agent) return { fail: "нет агента с ролью judge в наборе задачи" };
		if (!alive(agent)) return { fail: `агент ${agent.name} (judge): мёртв` };
		const rd = rdOf(task.round);
		sendStage(agent, rd, "brief-judge.md", buildBrief(task, "judge"));
		const wv = { label: `${task.id} judge ${agent.name}`, softMs: STAGE_TIMEOUT_MS, isAborted: aborted, isAlive: () => alive(agent), notify };
		const r = await waitWhileAlive(() => fs.existsSync(path.join(rd, "done-judge")), wv);
		if (r !== "ok") return { fail: r === "aborted" ? "aborted" : `агент ${agent.name} (judge): мёртв` };
		const vf = path.join(rd, "judge-verdict.json");
		let v = parseVerdict(vf) ?? (await waitForVerdict(vf, wv));
		if (!v) {
			// один запрос на переписывание, повторное ожидание
			await sendTo(agent, `[pipeline ${task.id}] ${vf} невалидный JSON. Перезапиши по шаблону PROTOCOL.md §judge (verdict + issues).`);
			v = await waitForVerdict(vf, wv);
			if (!v) return { fail: "судья не выдал валидный judge-verdict.json (агент умер)" };
		}
		return { v };
	};

	try {
		while (!aborted()) {
			const sliced1 = task.mode === "sliced" && task.round === 1;

			if (sliced1) {
				const rd = rdOf(task.round);
				// 1) decompose: planner дробит spec на слайсы
				task.stage = "planner";
				saveState(task);
				const planner = agentFor("planner");
				if (!planner) return escalate("нет агента с ролью planner в наборе задачи");
				if (!alive(planner)) return escalate(`агент ${planner.name} (planner): мёртв`);
				if (!deps.spawnSliceWorker) return escalate("sliced-режим: нет транспорта для slice-воркеров (нужен rpc)");
				const spawnSlice = deps.spawnSliceWorker;
				sendStage(planner, rd, "brief-decompose.md", buildDecomposeBrief(task));
				const sf = path.join(rd, "slices.json");
				const maxS = task.slice_count ?? 6;
				const dr = await waitWhileAlive(() => parseSlices(sf, maxS) !== null, {
					label: `${task.id} decompose ${planner.name}`, softMs: STAGE_TIMEOUT_MS, isAborted: aborted, isAlive: () => alive(planner), notify,
				});
				if (dr === "aborted") return;
				if (dr !== "ok") return escalate(`planner не выдал валидный slices.json (${dr === "dead" ? `агент ${planner.name} умер` : "недопустимый формат: массив из 2..${maxS} объектов {name, scope, brief}"})`);
				const slices = parseSlices(sf, maxS)!;
				// 2) slice-воркеры параллельно, каждый в своём worktree
				task.stage = "worker";
				saveState(task);
				const wr = await Promise.all(
					slices.map(async (s, k) => {
						const wt = path.join(task.dir, "worktrees", s.name);
						const branch = sliceBranch(task.id, task.round, s.name);
						try {
							worktreeAdd(task.cwd, wt, branch, task.base_head!);
						} catch (e) {
							return { s, ok: false, fail: `worktree add: ${(e as Error).message}`, wt: undefined, branch: undefined };
						}
						cleanups.push({ wt, branch });
						const agent = await spawnSlice(task, s, wt);
						sliceAgents.push(agent);
						const srd = path.join(rd, `slice-${k + 1}`);
						sendStage(agent, srd, "brief-slice.md", buildSliceBrief(task, s, srd, wt));
						const w = await waitForStage(task, srd, deps, agent);
						return { s, ok: w.ok, fail: w.ok ? undefined : w.reason, wt, branch };
					}),
				);
				const failed = wr.filter((r) => !r.ok);
				if (failed.length) return escalate(failed.map((r) => `слайс ${r.s.name}: ${r.fail ?? "worker не завершил этап"}`).join("; "));
				// 3) commit worktree'ов + merge в основное дерево
				for (const r of wr) {
					commitAll(r.wt!, `${task.id}: слайс ${r.s.name}`);
					if (!merge(task.cwd, r.branch!, `${task.id}: слайс ${r.s.name}`)) {
						return escalate(`merge-конфликт слайса ${r.s.name} (ветка ${r.branch}): разреши вручную, worktrees — ${path.join(task.dir, "worktrees")}`);
					}
				}
			} else {
				// 1) worker (обычный)
				task.stage = "worker";
				saveState(task);
				const worker = agentFor("worker");
				if (!worker) return escalate("нет агента с ролью worker в наборе задачи");
				if (!alive(worker)) return escalate(`агент ${worker.name} (worker): мёртв`);
				const rd = rdOf(task.round);
				sendStage(worker, rd, "brief-worker.md", buildBrief(task, "worker"));
				const w = await waitForStage(task, rd, deps, worker);
				if (!w.ok) {
					if (w.reason === "aborted") return;
					const reasons: Record<string, string> = {
						dead: `агент ${worker.name} (worker): мёртв (панель/процесс пропал)`,
						"qa-loop": `worker зациклится на вопросах (> ${MAX_QA_PER_STAGE} Q&A за этап)`,
						"no-planner": "worker ждёт ответа, но planner недоступен",
						"qa-dead": "planner умер во время ответа на mid-round вопросы",
					};
					return escalate(reasons[w.reason]);
				}
			}

			// 2) planner ∥ judge — параллельно (не зависят друг от друга: planner — по отчётам,
			//    judge — по spec+diff). Решение по раунду — после обоих.
			task.stage = "judge";
			saveState(task);
			const [pr, jr] = await Promise.all([plannerStage(), judgeStage()]);
			if (aborted()) return;
			if (!jr.v) return escalate(jr.fail!);
			const v = jr.v;
			task.history.push({ round: task.round, verdict: v.verdict, issues: v.issues, notes: v.notes });
			saveState(task);
			if (v.verdict === "pass") {
				task.stage = "done";
				saveState(task);
				for (const c of cleanups) {
					worktreeRemove(task.cwd, c.wt);
					branchDelete(task.cwd, c.branch);
				}
				notify(`[commander] ${task.id}: PASS за ${task.round} раунд(ов).${v.notes ? ` Notes: ${v.notes}` : ""} История: ${task.dir}`);
				return;
			}
			if (v.verdict === "blocked") {
				return escalate(`judge: blocked — ${v.notes ?? "не может оценить (spec противоречив?)"}`);
			}
			if (!pr.ok) {
				return escalate(`planner не выдал решение (${pr.reason}) — R-требования к раунду ${task.round + 1} не готовы; вердикт судьи: revise, issues в round-${task.round}/judge-verdict.json`);
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
	} finally {
		for (const a of sliceAgents) deps.killAgent?.(a);
	}
	notify(`[commander] ${task.id}: aborted (остановлен пользователем).`);
}
