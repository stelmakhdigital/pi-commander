/** Selfcheck: npm test */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrief, buildDecomposeBrief, buildSliceBrief, isCycle, parseSlices, parseVerdict, readState, findQueuedTasks, findClaimingTasks, normalizeAgent, type Issue, type TaskState } from "../state.ts";
import { PROTOCOL } from "../protocol.ts";
import { applyTemplate, listTemplates, TEMPLATES_DIR } from "../templates.ts";

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
	cwd: tmp,
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

// parseSlices: 2..max объектов {name, brief}
const sfile = path.join(tmp, "slices.json");
fs.writeFileSync(sfile, JSON.stringify([{ name: "s1", scope: "a/", brief: "A" }, { name: "s2", scope: "b/", brief: "B" }]));
assert.equal(parseSlices(sfile, 6)?.length, 2, "slices: 2 валидных");
fs.writeFileSync(sfile, JSON.stringify([{ name: "s1", brief: "A" }]));
assert.equal(parseSlices(sfile, 6), null, "slices: 1 < 2 — нет");
fs.writeFileSync(sfile, JSON.stringify([{ name: "a", brief: "x" }, { name: "b", brief: "y" }, { name: "c", brief: "z" }]));
assert.equal(parseSlices(sfile, 2), null, "slices: 3 > max — нет");
fs.writeFileSync(sfile, "nope");
assert.equal(parseSlices(sfile, 6), null, "slices: не-JSON — нет");

// buildDecomposeBrief / buildSliceBrief
const st: TaskState = { ...task, mode: "sliced", slice_count: 3, round: 1 };
const dbrief = buildDecomposeBrief(st);
assert.ok(dbrief.includes("slices.json") && dbrief.includes("done-decompose"), "decompose brief: slices.json + done-decompose");
const sbrief = buildSliceBrief(st, { name: "s1", scope: "a/", brief: "B" }, path.join(tmp, "round-1", "slice-1"), "/wt/a");
assert.ok(sbrief.includes("/wt/a") && sbrief.includes("done-worker") && sbrief.includes("git commit"), "slice brief: worktree + commit + done-worker");
assert.ok(PROTOCOL.includes("## slices"), "protocol: секция slices");

// очередь: queued-задачи видны планировщику и занимают агентов
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-cwd-"));
const pdir = path.join(cwd, ".pi", "pipeline");
for (const [id, stage, w] of [["T-1", "worker", "w-1"], ["T-2", "worker", "w-2"], ["T-3", "queued", "w-3"]] as const) {
	const d = path.join(pdir, id);
	fs.mkdirSync(path.join(d, "round-1"), { recursive: true });
	fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ ...task, id, dir: d, stage, cwd, agents: { worker: w } }));
}
assert.equal(readState(cwd, "T-1")?.stage, "worker");
assert.equal(readState(cwd, "NOPE"), null);
assert.equal(findQueuedTasks(cwd).map((t) => t.id).join(), "T-3", "очередь: только queued");
assert.equal(findClaimingTasks(cwd).length, 3, "claiming: worker+worker+queued");
assert.ok(PROTOCOL.includes("## Q&A"), "protocol: секция Q&A");
assert.ok(PROTOCOL.includes("ask-worker.md"), "protocol: ask-файл");
assert.ok(PROTOCOL.includes("Критерии приёмки"), "protocol: spec-контракт");

// шаблоны: список, копирование в чистый проект, guard от повторного применения
assert.ok(listTemplates().includes("basic"), "templates: basic в списке");
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "commander-proj-"));
const tRes = applyTemplate("basic", proj);
assert.ok(
	tRes.copied.includes("task.md") && tRes.copied.includes("worker_roles.md") && tRes.copied.includes("worker_prompt_addition.md"),
	"templates: все файлы скопированы",
);
assert.throws(() => applyTemplate("basic", proj), /task\.md/, "templates: повторное применение отклонено (task.md уже есть)");
assert.throws(() => applyTemplate("../templates", proj), /недопустимое имя/, "templates: выход за пределы templates/ запрещён");
assert.throws(() => applyTemplate("no-such-template", proj), /не найден/, "templates: неизвестный шаблон");

// шаблоны: новая директория в templates/ = новый шаблон, код не трогаем
const tmpT = path.join(TEMPLATES_DIR, "zz-selfcheck-tmp");
fs.mkdirSync(tmpT, { recursive: true });
fs.writeFileSync(path.join(tmpT, "x.md"), "x");
try {
	assert.ok(listTemplates().includes("zz-selfcheck-tmp"), "templates: новая директория видна в списке");
	const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-proj2-"));
	assert.deepEqual(applyTemplate("zz-selfcheck-tmp", proj2).copied, ["x.md"], "templates: новый шаблон копируется");
} finally {
	fs.rmSync(tmpT, { recursive: true });
}

console.log("selfcheck: OK");
