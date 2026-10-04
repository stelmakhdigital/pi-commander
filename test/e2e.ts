/** E2E: runTask с фейковыми агентами — полный цикл: Q&A в раунде 1, revise → pass в раунде 2. Запуск: npm run test:e2e */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask, type Agent, type TaskState } from "../state.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-e2e-"));
const dir = path.join(cwd, ".pi", "pipeline", "T-e2e");
fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });

const task: TaskState = {
	id: "T-e2e",
	dir,
	base_head: null,
	round: 1,
	stage: "worker",
	max_rounds: 3,
	history: [],
	agents: { worker: "w", planner: "p", judge: "j" },
	started_at: "",
};

const agents: Agent[] = [
	{ name: "w", role: "worker", surface: { kind: "tmux", target: "%1" } },
	{ name: "p", role: "planner", surface: { kind: "tmux", target: "%2" } },
	{ name: "j", role: "judge", surface: { kind: "tmux", target: "%3" } },
];

const sent: string[] = [];
const notified: string[] = [];
const rdOf = (line: string) => path.join(dir, line.match(/round-\d+/)![0]);

// Фейковые агенты: на brief делают артефакт + done; worker в R1 сначала задаёт вопрос
const sendTo = (a: Agent, line: string) => {
	sent.push(line);
	const rd = rdOf(line);
	fs.mkdirSync(rd, { recursive: true });
	if (a.role === "worker") {
		if (line.includes("brief-worker")) {
			fs.writeFileSync(path.join(rd, "ask-worker.md"), "[Q1] Какое Хранилище выбрать?");
			return; // worker ждёт ответа
		}
		fs.writeFileSync(path.join(rd, "worker-report.md"), "# Round — Worker\n## Статус: done\n");
		fs.writeFileSync(path.join(rd, "done-worker"), "");
	} else if (a.role === "planner") {
		if (line.includes("Q&A")) {
			fs.writeFileSync(path.join(rd, "answers-1.md"), "[Q1] → Redis, по референсу spec\n");
			fs.writeFileSync(path.join(rd, "answered-1"), "");
			return;
		}
		fs.writeFileSync(path.join(rd, "planner-decision.md"), "# Round — Planner\n## Требования: [R1] ничего\n");
		fs.writeFileSync(path.join(rd, "done-planner"), "");
	} else {
		const verdict = line.includes("round-1")
			? { verdict: "revise", issues: [{ id: "I1", sev: "major", what: "нет кэша", file: "a.ts" }] }
			: { verdict: "pass", issues: [] };
		fs.writeFileSync(path.join(rd, "judge-verdict.json"), JSON.stringify(verdict));
		fs.writeFileSync(path.join(rd, "done-judge"), "");
	}
};

await runTask(task, { agents, sendTo, alive: () => true, notify: (t) => notified.push(t) });

assert.equal(task.stage, "done", `stage=${task.stage}: ${task.notes}`);
assert.equal(task.round, 2, "должен пройти 2 раунда (revise → pass)");
assert.equal(task.history.length, 2);
assert.equal(task.history[0].verdict, "revise");
assert.equal(task.history[1].verdict, "pass");
assert.ok(sent.some((l) => l.includes("→ planner Q&A")), "Q&A ушёл planner'у");
assert.ok(sent.some((l) => l.includes("Ответы архитектора")), "ответы пересланы worker'у");
assert.ok(fs.existsSync(path.join(dir, "round-1", "ask-worker-1.md")), "ask-файл архивирован");
assert.ok(fs.existsSync(path.join(dir, "round-1", "answers-1.md")), "ответы на диске");
assert.ok(fs.existsSync(path.join(dir, "round-2", "judge-verdict.json")), "вердикт R2");
assert.ok(notified.some((t) => t.includes("PASS за 2 раунд")), "notify: PASS");

// abort: файл .abort останавливает крутящийся цикл (in-memory stage не меняется tool'ом)
const dir2 = path.join(cwd, "T-abort");
fs.mkdirSync(path.join(dir2, "round-1"), { recursive: true });
const t2: TaskState = { id: "T-abort", dir: dir2, base_head: null, round: 1, stage: "worker", max_rounds: 1, history: [], agents: { worker: "w" }, started_at: "" };
const p2 = runTask(t2, {
	agents: [{ name: "w", role: "worker", surface: { kind: "tmux", target: "%9" } }],
	sendTo: () => {}, alive: () => true, notify: () => {},
});
await new Promise((r) => setTimeout(r, 2000)); // worker «работает» (done-файла нет)
fs.writeFileSync(path.join(dir2, ".abort"), "");
await Promise.race([p2, new Promise((_, rej) => setTimeout(() => rej(new Error("abort не сработал")), 10_000))]);
console.log("e2e abort: OK");
console.log("e2e: OK (" + sent.length + " сообщений, " + task.history.map((h) => h.verdict).join("→") + ")");
