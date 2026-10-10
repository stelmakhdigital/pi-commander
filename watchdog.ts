/**
 * Watchdog pipeline-задач: ловит застрявших агентов (зацикливание/простой) внутри
 * работающего этапа и разбирается с ними автоматически:
 *   1) без НОВОГО прогресса nuIdleMs → nudge агенту (сообщение с явными выходами:
 *      done-файл / ask-файл / продолжить; максимум maxNudges, с интервалом);
 *   2) прогресс так и не появился hardIdleMs — или этап старше stageHardMs →
 *      АВТО-эскалация задачи: .escalate-файл (крутящийся runTask его видит и
 *      останавливается), stage=escalated, notify, агенты освобождаются.
 *
 * Прогресс = «сигнатура» стадии, пересчитывается каждый тик:
 *  - git: status --porcelain + diff --stat HEAD в репо задачи (+ каждый worktree в sliced);
 *  - директория задачи: mtime+число файлов (артефакты, ask/answers-файлы).
 * Сигнатура, уже встречавшаяся в последних recentWindow тиков, прогрессом НЕ
 * считается — защита от «пинг-понга» (агент по кругу правит одно и то же).
 * rpc-актёр: «turn уже завершился» (agent_settled) при отсутствии done-файла —
 * сильный сигнал зацикливания, добавляется в текст nudge'а.
 * read-loop (rpc): хвост сессии (jsonl) без единого изменяющего tool-вызова и с одним
 * и тем же действием ≥ 6× в окне 30 — зацикливание ловится сразу (nudge/эскалация
 * не ждут idle-порогов), например «по кругу читает инструкции из файла».
 *
 * Детерминирован, без LLM. Состояние in-memory на задачу — conductor живёт дольше задач.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { findActiveTasks, parseSlices, readEscalation, requestEscalation, saveState, type Agent, type TaskState } from "./state.ts";
import { isRepo } from "./git.ts";

/** Пороги (мс). В тестах переопределяются через конструктор. */
export const WD = {
	tickMs: 30_000,
	nuIdleMs: 15 * 60_000, // без нового прогресса → nudge
	nuIntervalMs: 10 * 60_000, // минимальный интервал между nudge'ами
	maxNudges: 2,
	hardIdleMs: 45 * 60_000, // прогресса нет и nudge'и исчерпаны → эскалация
	stageHardMs: 3 * 3_600_000, // этап длится дольше → эскалация даже при «прогрессе»
	recentWindow: 10, // окно дедупликации сигнатур
	settledMs: 90_000, // agent_settled старше этого = turn завершён
};

export interface WatchdogHooks {
	alive: (a: Agent) => boolean;
	sendTo: (a: Agent, line: string) => void;
	notify: (t: string) => void;
	/** rpc-актёр: turn завершился (agent_settled), но done-файла нет? tmux — false. */
	settled: (a: Agent) => boolean;
	/** Каталог сессий rpc-агента (для детекта зацикливания по tool-вызовам). tmux — null. */
	sessionDir: (t: TaskState, a: Agent) => string | null;
	/** Актуальные актёры задачи (по текущему stage; sliced round 1 — slice-агенты). */
	actors: (t: TaskState) => Agent[];
	/** Planner задачи (для nudge во время mid-round Q&A). */
	plannerOf: (t: TaskState) => Agent | null;
}

interface Markers {
	done: string;
	ask?: string;
	/** Дополнительный артефакт (planner-decision.md / judge-verdict.json). */
	artifact?: string;
}

/** done/ask-маркеры актёра в текущем раунде. null — маркеры не определяются (пропустить). */
export function markersFor(t: TaskState, a: Agent): Markers | null {
	const rd = path.join(t.dir, `round-${t.round}`);
	if (a.role === "worker") {
		if (t.mode === "sliced" && t.round === 1) {
			const slices = parseSlices(path.join(rd, "slices.json"), 6);
			const k = slices ? slices.findIndex((s) => a.name.endsWith(`/${s.name}`)) : -1;
			if (k < 0) return null;
			const srd = path.join(rd, `slice-${k + 1}`);
			return { done: path.join(srd, "done-worker"), ask: path.join(srd, "ask-worker.md") };
		}
		return { done: path.join(rd, "done-worker"), ask: path.join(rd, "ask-worker.md") };
	}
	if (a.role === "planner")
		return t.mode === "sliced" && t.round === 1
			? { done: path.join(rd, "done-decompose") }
			: { done: path.join(rd, "done-planner"), artifact: path.join(rd, "planner-decision.md") };
	return { done: path.join(rd, "done-judge"), artifact: path.join(rd, "judge-verdict.json") };
}

/** Mid-round Q&A в ожидании: worker записал ask-worker-<k>, planner ещё не ответил. */
export function pendingQa(t: TaskState): { ask: string; answers: string; done: string } | null {
	const dirs: string[] = [path.join(t.dir, `round-${t.round}`)];
	if (t.mode === "sliced" && t.round === 1) {
		const rd = path.join(t.dir, "round-1");
		for (const e of fs.existsSync(rd) ? fs.readdirSync(rd, { withFileTypes: true }) : [])
			if (e.isDirectory() && e.name.startsWith("slice-")) dirs.push(path.join(rd, e.name));
	}
	for (const d of dirs) {
		for (let k = 1; k <= 10; k++) {
			const ask = path.join(d, `ask-worker-${k}.md`);
			const done = path.join(d, `answered-${k}`);
			if (fs.existsSync(ask) && !fs.existsSync(done)) return { ask, answers: path.join(d, `answers-${k}.md`), done };
		}
	}
	return null;
}

function gitSig(cwd: string): string {
	try {
		const st = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const ds = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return (st + "\n" + ds).slice(0, 4000);
	} catch {
		return "";
	}
}

/* --- Детект зацикливания по логам сессий (rpc-агенты) ---
 * Сценарий «по кругу читает инструкции»: в окне последних tool-вызовов нет НИ ОДНОГО
 * изменяющего (write/edit/bash с мутациями), а одно и то же действие повторяется много раз.
 * Если изменения есть — это (возможно) реальная работа, ей занимается сигнатурная логика. */
const MUTATING_TOOL = /^(write|edit)$/;
const MUTATING_CMD =
	/(^|\s)(tee|mv|cp|rm|touch|ln|chmod|chown|sed\s+-i|git\s+(add|commit|push|checkout|switch|restore|apply|merge|rebase|stash)|npm|npx|yarn|pnpm|node|bun|deno|make|pytest|cargo|go\s+build|just|pip\s+install|docker)(\s|$)/;

function toolKey(c: { name: string; arguments?: Record<string, unknown> }): string {
	const args = c.arguments ?? {};
	const key = args.path ?? args.file_path ?? args.command ?? args.query ?? args.pattern ?? args.url ?? args.target ?? "";
	return `${c.name}(${String(key).trim().slice(0, 120)})`;
}

/** Последний jsonl в sessionDir: «read-loop»? true — если окно без мутаций и одно действие ≥ minFreq раз. */
export function sessionLoopDetect(
	sessionDir: string,
	window = 30,
	minFreq = 6,
): { loop: boolean; detail?: string } {
	let latest: string | null = null;
	let mtime = -1;
	try {
		for (const e of fs.readdirSync(sessionDir)) {
			if (!e.endsWith(".jsonl")) continue;
			const m = fs.statSync(path.join(sessionDir, e)).mtimeMs;
			if (m > mtime) {
				mtime = m;
				latest = path.join(sessionDir, e);
			}
		}
	} catch {
		return { loop: false };
	}
	if (!latest) return { loop: false };
	let tail = "";
	try {
		const size = fs.statSync(latest).size;
		const start = Math.max(0, size - 1_000_000); // хвост 1 МБ достаточно для окна 30 вызовов
		const fd = fs.openSync(latest, "r");
		try {
			const buf = Buffer.alloc(size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			tail = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { loop: false };
	}
	const sigs: { key: string; mutating: boolean }[] = [];
	for (const line of tail.split("\n")) {
		if (!line.includes('"toolCall"')) continue;
		try {
			const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
			if (!Array.isArray(content)) continue;
			for (const c of content as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
				if (c?.type !== "toolCall" || !c.name) continue;
				const mutating = MUTATING_TOOL.test(c.name) || (c.name === "bash" && MUTATING_CMD.test(String(c.arguments?.command ?? "")));
				sigs.push({ key: toolKey(c), mutating });
			}
		} catch {}
	}
	const w = sigs.slice(-window);
	if (w.length < window / 2) return { loop: false }; // актёр только начал — не судим
	if (w.some((s) => s.mutating)) return { loop: false }; // есть изменения — не read-loop
	const freq = new Map<string, number>();
	for (const s of w) freq.set(s.key, (freq.get(s.key) ?? 0) + 1);
	let top: [string, number] | null = null;
	for (const [k, n] of freq) if (!top || n > top[1]) top = [k, n];
	if (top && top[1] >= minFreq)
		return { loop: true, detail: `${top[0]} — ${top[1]}× за последние ${w.length} tool-вызовов, без изменений файлов` };
	return { loop: false };
}

/** Активность каталога: число файлов + max mtime (recursively; skipDirs — по имени). */
function dirSig(dir: string, skipDirs: Set<string>): string {
	let max = 0;
	let n = 0;
	const walk = (d: string) => {
		let es: fs.Dirent[];
		try {
			es = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of es) {
			if (e.isDirectory()) {
				if (skipDirs.has(e.name)) continue;
				walk(path.join(d, e.name));
			} else {
				n++;
				try {
					const m = fs.statSync(path.join(d, e.name)).mtimeMs;
					if (m > max) max = m;
				} catch {}
			}
		}
	};
	walk(dir);
	return `${n}:${max}`;
}

/** Сигнатура стадии задачи: всё, что говорит «агент что-то меняет». */
export function taskSignature(t: TaskState): string {
	const parts: string[] = [`${t.stage}:${t.round}`, dirSig(t.dir, new Set(["worktrees", "sessions"]))];
	if (isRepo(t.cwd)) parts.push(gitSig(t.cwd));
	if (t.mode === "sliced" && t.round === 1) {
		const wtRoot = path.join(t.dir, "worktrees");
		for (const e of fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot, { withFileTypes: true }) : [])
			if (e.isDirectory()) parts.push(gitSig(path.join(wtRoot, e.name)));
	}
	return createHash("sha1").update(parts.join("\0")).digest("hex");
}

interface WdTask {
	key: string; // stage:round — смена этапа = заново наблюдать
	recent: string[]; // недавние сигнатуры (окно дедупликации)
	lastChangeAt: number;
	nudges: number;
	lastNudgeAt: number;
}

export class Watchdog {
	private st = new Map<string, WdTask>();
	private readonly C: typeof WD;

	constructor(cfg: Partial<typeof WD> = {}) {
		this.C = { ...WD, ...cfg };
	}

	/** Один тик по всем активным задачам cwd. */
	tick(cwd: string, h: WatchdogHooks): void {
		const now = Date.now();
		const active = findActiveTasks(cwd);
		const ids = new Set(active.map((t) => t.id));
		for (const k of [...this.st.keys()]) if (!ids.has(k)) this.st.delete(k);
		for (const t of active) {
			if (readEscalation(t)) continue;
			try {
				this.tickTask(t, h, now);
			} catch {}
		}
	}

	private tickTask(t: TaskState, h: WatchdogHooks, now: number): void {
		const key = `${t.stage}:${t.round}`;
		let w = this.st.get(t.id);
		if (!w || w.key !== key) {
			this.st.set(t.id, { key, recent: [taskSignature(t)], lastChangeAt: now, nudges: 0, lastNudgeAt: 0 });
			return; // новый этап — наблюдать с чистого листа
		}
		const sig = taskSignature(t);
		const fresh = !w.recent.includes(sig);
		w.recent.push(sig);
		if (w.recent.length > this.C.recentWindow) w.recent.shift();
		if (fresh) {
			w.lastChangeAt = now;
			w.nudges = 0;
			w.lastNudgeAt = 0;
			return;
		}
		const idle = now - w.lastChangeAt;
		const age = t.stage_started_at ? now - Date.parse(t.stage_started_at) : 0;
		const mins = Math.round(idle / 60000);

		// 1) авто-эскалация
		if (idle >= this.C.hardIdleMs || age >= this.C.stageHardMs) {
			this.escalate(
				t,
				h,
				idle >= this.C.hardIdleMs
					? `нет нового прогресса ${mins} мин в этапе ${t.stage} (nudge'ов: ${w.nudges})`
					: `этап ${t.stage} длится ${Math.round(age / 3_600_000)} ч (жёсткий лимит)`,
			);
			return;
		}

		// 2) read-loop по логам сессий (rpc): зацикливание видно сразу, не ждём idle-пороги
		if (now - w.lastNudgeAt >= this.C.nuIntervalMs) {
			const loop = this.detectLoop(t, h);
			if (loop) {
				if (w.nudges >= this.C.maxNudges) {
					this.escalate(t, h, `зацикливание в действиях агента: ${loop.detail}`);
					return;
				}
				try {
					h.sendTo(
						loop.actor,
						`[pipeline ${t.id} R${t.round} → ${loop.actor.role} ⚠ watchdog] Вижу повторяющиеся действия в логе: ${loop.detail}. Ты, похоже, зациклился: НЕ перечитывай инструкции/файлы повторно — примени уже прочитанное. 1) работа выполнена — создай done-файл; 2) нужно решение — ask-файл; 3) продолжай работу другими действиями. Без реакции задача будет автоматически эскалирована.`,
					);
					w.nudges++;
					w.lastNudgeAt = now;
				} catch {}
				return; // в этом тике idle-nudge не дублируем
			}
		}

		// 3) nudge за отсутствие прогресса
		if (idle < this.C.nuIdleMs || w.nudges >= this.C.maxNudges || now - w.lastNudgeAt < this.C.nuIntervalMs) return;
		const sent = this.nudge(t, h, mins);
		if (sent) {
			w.nudges++;
			w.lastNudgeAt = now;
		}
	}

	/** Найти актёра с read-loop по его сессии (rpc; tmux — sessionDir null). */
	private detectLoop(t: TaskState, h: WatchdogHooks): { actor: Agent; detail: string } | null {
		for (const a of h.actors(t)) {
			const dir = h.sessionDir(t, a);
			if (!dir) continue;
			const d = sessionLoopDetect(dir);
			if (d.loop && d.detail) return { actor: a, detail: d.detail };
		}
		return null;
	}

	private escalate(t: TaskState, h: WatchdogHooks, reason: string): void {
		requestEscalation(t, reason);
		t.stage = "escalated";
		t.notes = `watchdog: ${reason}`;
		saveState(t);
		h.notify(
			`[commander] ${t.id}: ⚠ WATCHDOG — ${reason}. Задача остановлена (stage=escalated), агенты освобождены. pipeline_status → детали; дальше: запуск заново или помощь агенту через pipeline_send.`,
		);
	}

	/** Написать кому-то, кто сейчас «должен» продвинуть задачу. true = отправлено ≥1. */
	private nudge(t: TaskState, h: WatchdogHooks, mins: number): boolean {
		// Mid-round Q&A: ждём именно planner'а (worker в это время честно ждёт ответа).
		const qa = t.stage === "worker" ? pendingQa(t) : null;
		if (qa) {
			const planner = h.plannerOf(t);
			if (planner && h.alive(planner)) {
				try {
					h.sendTo(
						planner,
						`[pipeline ${t.id} R${t.round} → ${planner.name} ⚠ watchdog] Worker ${mins} мин ждёт твоих ответов: ${qa.ask}. Ответь на каждый вопрос (read-only), запиши в ${qa.answers} и сделай финальный шаг: создать ${qa.done}.`,
					);
					return true;
				} catch {}
			}
			return false;
		}
		let sent = false;
		for (const a of h.actors(t)) {
			const m = markersFor(t, a);
			if (!m || fs.existsSync(m.done) || !h.alive(a)) continue;
			try {
				h.sendTo(a, this.nudgeLine(t, a, m, mins, h.settled(a)));
				sent = true;
			} catch {}
		}
		return sent;
	}

	private nudgeLine(t: TaskState, a: Agent, m: Markers, mins: number, settled: boolean): string {
		const exits =
			a.role === "worker" && m.ask
				? `1) работа выполнена — создай ${m.done}; 2) нужно решение архитектора — напиши вопросы в ${m.ask}; 3) продолжаешь работу — продолжай, но БЕЗ повторения одних и тех же действий.`
				: a.role === "planner"
				  ? `1) напиши решение в ${m.artifact} и создай ${m.done}; 2) не можешь продолжить — зафиксируй это в решении И всё равно создай ${m.done} (цикл остановится, человек посмотрит).`
				  : `1) напиши валидный JSON в ${m.artifact} и создай ${m.done}; 2) не можешь оценить — verdict "blocked" с причиной в notes + ${m.done}.`;
		return `[pipeline ${t.id} R${t.round} → ${a.role} ⚠ watchdog] ${mins} мин без нового прогресса (изменений в репо/артефактах не видно).${
			settled ? " Твой turn уже завершён, но done-файла нет — pipeline ждёт его." : ""
		} Выбери: ${exits} Без реакции задача будет автоматически эскалирована.`;
	}
}
