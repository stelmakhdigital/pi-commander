/** Selfcheck: npm test */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrief, isCycle, parseVerdict, readState, normalizeAgent, type Issue, type TaskState } from "../state.ts";
import { PROTOCOL } from "../protocol.ts";

const i = (file: string, what: string): Issue => ({ id: "I1", sev: "major", what, file });

// cycle-detect
assert.equal(isCycle([i("a.ts", "баг в парсинге даты")], [i("a.ts", "баг в парсинге даты")]), true);
assert.equal(isCycle([i("a.ts", "баг в парсинге даты")], [i("b.ts", "что-то совсем другое")]), false);
assert.equal(isCycle([], [i("a.ts", "x")]), false);
assert.equal(isCycle([i("a.ts", "x"), i("b.ts", "y"), i("c.ts", "z")], [i("a.ts", "x")]), false); // 1/3 — не цикл

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commander-"));
const vf = path.join(tmp, "judge-verdict.json");

// parseVerdict
fs.writeFileSync(vf, JSON.stringify({ verdict: "revise", issues: [{ id: "I1", sev: "blocker", what: "x" }] }));
assert.equal(parseVerdict(vf)?.verdict, "revise");
fs.writeFileSync(vf, "{ nope");
assert.equal(parseVerdict(vf), null);
fs.writeFileSync(vf, JSON.stringify({ verdict: "whatever", issues: [] }));
assert.equal(parseVerdict(vf), null);

// buildBrief
const task: TaskState = {
	id: "T-test",
	dir: tmp,
	base_head: null,
	round: 2,
	stage: "worker",
	max_rounds: 3,
	history: [{ round: 1, verdict: "revise", issues: [i("a.ts", "x")] }],
	started_at: "",
};
const wbrief = buildBrief(task, "worker");
assert.ok(wbrief.includes("round-2/done-worker"), "worker brief: done-маркер");
assert.ok(wbrief.includes("round-1/judge-verdict.json"), "worker brief: issues прошлого раунда");
assert.ok(wbrief.includes("round-1/planner-decision.md"), "worker brief: R-требования");
assert.ok(wbrief.includes("ask-worker.md"), "worker brief: mid-round Q&A");
const pbrief = buildBrief(task, "planner");
assert.ok(pbrief.includes("round-2/done-planner") && pbrief.includes("worker-report.md"), "planner brief");
task.base_head = "abc123";
const jbrief = buildBrief(task, "judge");
assert.ok(jbrief.includes("round-2/done-judge") && jbrief.includes("git diff abc123"), "judge brief: diff от base_head");
assert.ok(jbrief.includes("НЕ читаешь"), "judge brief: изоляция от процесса");

// normalizeAgent: миграция старого формата { pane } → surface
const migrated = normalizeAgent({ name: "atlas", role: "worker", pane: "%12" });
assert.ok(migrated && migrated.surface.kind === "tmux" && migrated.surface.target === "%12");
const fresh = normalizeAgent({ name: "arch", role: "planner", surface: { kind: "rpc", model: "m" } });
assert.ok(fresh && fresh.surface.kind === "rpc");
assert.equal(normalizeAgent({ name: "bad", role: "hacker" }), null);

// параллельные задачи: два активных state в разных каталогах
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-cwd-"));
const pdir = path.join(cwd, ".pi", "pipeline");
for (const id of ["T-1", "T-2"]) {
	const d = path.join(pdir, id);
	fs.mkdirSync(path.join(d, "round-1"), { recursive: true });
	fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ ...task, id, dir: d, stage: "worker", agents: { worker: `w-${id}` } }));
}
assert.equal(readState(cwd, "T-1")?.stage, "worker");
assert.equal(readState(cwd, "NOPE"), null);

// PROTOCOL: Q&A-секция для bootstrap'а агентов
assert.ok(PROTOCOL.includes("## Q&A"), "protocol: секция Q&A");
assert.ok(PROTOCOL.includes("ask-worker.md"), "protocol: ask-файл");
assert.ok(PROTOCOL.includes("Критерии приёмки"), "protocol: spec-контракт");

console.log("selfcheck: OK");
