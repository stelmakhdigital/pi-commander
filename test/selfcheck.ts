/** Selfcheck: npm test */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrief, buildDecomposeBrief, buildSliceBrief, isCycle, parseSlices, parseVerdict, readState, findQueuedTasks, findClaimingTasks, normalizeAgent, requestEscalation, readEscalation, type Agent, type Issue, type TaskState } from "../state.ts";
import { Watchdog, taskSignature, sessionLoopDetect } from "../watchdog.ts";
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

// watchdog: без прогресса → nudge → авто-эскалация; есть прогресс → тишина
const wdcwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd-"));
const wdir = path.join(wdcwd, ".pi", "pipeline", "T-wd");
fs.mkdirSync(path.join(wdir, "round-1"), { recursive: true });
const wtask: TaskState = {
	id: "T-wd", dir: wdir, base_head: null, cwd: wdcwd, round: 1, stage: "worker", max_rounds: 3,
	history: [], agents: { worker: "w1" }, started_at: "", stage_started_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(wdir, "state.json"), JSON.stringify(wtask));
const wd = new Watchdog({ nuIdleMs: 0, nuIntervalMs: 0, hardIdleMs: 30, stageHardMs: 1e9, recentWindow: 5 });
const wactor: Agent = { name: "w1", role: "worker", surface: { kind: "rpc" } };
const sent: string[] = [];
const noted: string[] = [];
const whooks = { alive: () => true, sendTo: (_a: Agent, l: string) => sent.push(l), notify: (t: string) => noted.push(t), settled: () => false, sessionDir: () => null, actors: () => [wactor], plannerOf: () => null };
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
wd.tick(wdcwd, whooks); // инициализация наблюдения
await sleepMs(5);
wd.tick(wdcwd, whooks); // прогресса нет → nudge №1
assert.equal(sent.length, 1, "watchdog: nudge №1 отправлен");
assert.ok(sent[0].includes("watchdog") && sent[0].includes("done-worker") && sent[0].includes("ask-worker.md"), "watchdog: в nudge'е выходы (done/ask)");
await sleepMs(5);
wd.tick(wdcwd, whooks); // → nudge №2 (максимум)
assert.equal(sent.length, 2, "watchdog: nudge №2 отправлен");
await sleepMs(40); // > hardIdleMs
wd.tick(wdcwd, whooks); // → авто-эскалация, без новых сообщений
assert.equal(sent.length, 2, "watchdog: после эскалации nudge'ов нет");
assert.equal(noted.length, 1, "watchdog: эскалация уведомлена");
assert.ok(noted[0].includes("WATCHDOG") && noted[0].includes("T-wd"), "watchdog: текст эскалации");
assert.equal(readState(wdcwd, "T-wd")?.stage, "escalated", "watchdog: stage=escalated на диске");
assert.ok(readEscalation(wtask), "watchdog: .escalate-файл с причиной");
wd.tick(wdcwd, whooks); // после эскалации — тишина
assert.equal(noted.length, 1, "watchdog: дублей эскалации нет");

// watchdog: файл изменился = прогресс, nudge не шлётся
const wdcwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd2-"));
const wdir2 = path.join(wdcwd2, ".pi", "pipeline", "T-wd2");
fs.mkdirSync(path.join(wdir2, "round-1"), { recursive: true });
const wtask2: TaskState = { ...wtask, id: "T-wd2", dir: wdir2, cwd: wdcwd2 };
fs.writeFileSync(path.join(wdir2, "state.json"), JSON.stringify(wtask2));
const sent2: string[] = [];
const whooks2 = { ...whooks, sendTo: (_a: Agent, l: string) => sent2.push(l) };
wd.tick(wdcwd2, whooks2); // инициализация (другая задача — отдельное состояние)
fs.writeFileSync(path.join(wdir2, "round-1", "worker-report.md"), "прогресс");
await sleepMs(5);
wd.tick(wdcwd2, whooks2); // новая сигнатура = прогресс → не нуджим
assert.equal(sent2.length, 0, "watchdog: прогресс (новый файл) — nudge не шлётся");
assert.notEqual(taskSignature({ ...wtask2 }), "", "taskSignature: строка");

// requestEscalation/readEscalation: round-trip
assert.equal(readEscalation(wtask2), null, "readEscalation: без файла — null");
requestEscalation(wtask2, "тест-причина");
assert.equal(readEscalation(wtask2), "тест-причина", "readEscalation: причина из .escalate");

// watchdog: read-loop по логам сессий — «по кругу читает инструкции»
const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "commander-sess-"));
const sessFile = path.join(sessDir, "s.jsonl");
const toolLine = (name: string, args: Record<string, unknown>) =>
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });
fs.writeFileSync(
	sessFile,
	Array.from({ length: 18 }, () => toolLine("read", { path: "/proj/INSTRUCTIONS.md" })).concat(toolLine("read", { path: "/proj/other.md" })).join("\n") + "\n",
);
const lp = sessionLoopDetect(sessDir);
assert.ok(lp.loop && (lp.detail ?? "").includes("INSTRUCTIONS.md"), "loop-detect: read по кругу пойман");
assert.ok((lp.detail ?? "").includes("без изменений"), "loop-detect: в detail — что изменений не было");
// с изменяющим вызовом в окне — не loop (агент реально работает)
fs.appendFileSync(sessFile, toolLine("write", { path: "/proj/a.ts" }) + "\n" + toolLine("read", { path: "/proj/INSTRUCTIONS.md" }) + "\n");
assert.equal(sessionLoopDetect(sessDir).loop, false, "loop-detect: есть write в окне — не loop");
// мало вызовов (актёр только начал) — не судим
const sessDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-sess2-"));
fs.writeFileSync(path.join(sessDir2, "s.jsonl"), Array.from({ length: 5 }, () => toolLine("read", { path: "x" })).join("\n") + "\n");
assert.equal(sessionLoopDetect(sessDir2).loop, false, "loop-detect: < 15 вызовов — не судим");
// полный цикл: read-loop → nudge сразу (не ждём idle-пороги) → эскалация после maxNudges
const wdcwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd3-"));
const wdir3 = path.join(wdcwd3, ".pi", "pipeline", "T-loop");
fs.mkdirSync(path.join(wdir3, "round-1"), { recursive: true });
const wtask3: TaskState = { ...wtask, id: "T-loop", dir: wdir3, cwd: wdcwd3 };
fs.writeFileSync(path.join(wdir3, "state.json"), JSON.stringify(wtask3));
const sent3: string[] = [];
const noted3: string[] = [];
const whooks3 = { alive: () => true, sendTo: (_a: Agent, l: string) => sent3.push(l), notify: (t: string) => noted3.push(t), settled: () => false, sessionDir: () => sessDir, actors: () => [wactor], plannerOf: () => null };
// в сессии снова только read-loop (обновим хвост без мутаций)
fs.writeFileSync(sessFile, Array.from({ length: 20 }, () => toolLine("read", { path: "/proj/INSTRUCTIONS.md" })).join("\n") + "\n");
wd.tick(wdcwd3, whooks3); // инициализация
wd.tick(wdcwd3, whooks3); // loop сразу → nudge №1 (idle-пороги 15/45 мин не ждут)
assert.equal(sent3.length, 1, "loop: nudge сразу");
assert.ok(sent3[0].includes("зациклился") && sent3[0].includes("INSTRUCTIONS.md"), "loop: текст nudge с деталями");
assert.equal(noted3.length, 0, "loop: до эскалации notify нет");

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
