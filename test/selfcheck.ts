/** Selfcheck: npm test */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBrief, buildDecomposeBrief, buildSliceBrief, isCycle, parseSlices, parseVerdict, readState, findQueuedTasks, findClaimingTasks, normalizeAgent, requestEscalation, readEscalation, type Agent, type Issue, type TaskState } from "../state.ts";
import { Watchdog, WD, wdConfig, taskSignature, sessionLoopDetect } from "../watchdog.ts";
import { LineBuffer } from "../rpc.ts";
import { isClean, isRepo, statusSig } from "../git.ts";
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
// имена уходят в путь worktree/ветку: путь наружу или ведущий '-' — отказ всей пачки
fs.writeFileSync(sfile, JSON.stringify([{ name: "../evil", brief: "x" }, { name: "b", brief: "y" }]));
assert.equal(parseSlices(sfile, 6), null, "slices: traversal-имя — отказ");
fs.writeFileSync(sfile, JSON.stringify([{ name: "-o", brief: "x" }, { name: "b", brief: "y" }]));
assert.equal(parseSlices(sfile, 6), null, "slices: имя-опция git — отказ");
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

// rpc: JSONL-фрейминг — запись может прийти разрезанной по chunk'ам и посреди
// UTF-8-символа; терялись события (watchdog не видел agent_settled)
{
	const lb = new LineBuffer();
	const b = (s: string) => Buffer.from(s, "utf8");
	assert.deepEqual(lb.push(b('{"a":')), [], "framing: неполная строка не отдаётся");
	assert.deepEqual(lb.push(b('1}\n{"type":"agent_settled"}')), ['{"a":1}'], "framing: склейка по границе chunk'а, хвост остаётся");
	assert.deepEqual(lb.push(b("\n")), ['{"type":"agent_settled"}'], "framing: хвост доезжает следующим chunk'ом");
	const rec = JSON.stringify({ type: "x", text: "долгий русский текст ".repeat(20) });
	const raw = b(rec + "\n");
	// разрез ровно внутри многобайтного символа (байт продолжения UTF-8)
	const cut = Math.max(1, raw.findIndex((x) => x >= 0x80 && x < 0xc0));
	const lb2 = new LineBuffer();
	assert.deepEqual(lb2.push(raw.subarray(0, cut)), [], "framing: разрез внутри UTF-8 — записи нет");
	assert.deepEqual(lb2.push(raw.subarray(cut)), [rec], "framing: разрез внутри UTF-8 восстанавливается");
}

// git: .pi/ (состояние conductor'а) не считается работой агента — иначе после
// первого же запуска дерево «не чистое» (slices недоступен), а watchdog видит прогресс
{
	const { execFileSync } = await import("node:child_process");
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "commander-git-"));
	const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@t");
	g("config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "a.txt"), "a");
	g("add", "-A");
	g("commit", "-q", "-m", "base");
	assert.ok(isRepo(repo), "git: isRepo");
	assert.equal(isClean(repo), true, "git: чистое дерево");
	// состояние conductor'а в .pi/pipeline (задачи, worktrees) — не грязь проекта
	fs.mkdirSync(path.join(repo, ".pi", "pipeline", "T-1", "round-1"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".pi", "pipeline", "T-1", "state.json"), "{}");
	assert.equal(isClean(repo), true, "git: .pi/pipeline не ломает «чистое дерево»");
	assert.ok(!(await statusSig(repo)).includes(".pi/pipeline"), "git: .pi вне сигнатуры прогресса");
	fs.writeFileSync(path.join(repo, "b.txt"), "b");
	assert.equal(isClean(repo), false, "git: реальная правка — дерево грязное");
	assert.ok((await statusSig(repo)).includes("b.txt"), "git: реальная правка видна в сигнатуре");
}

// watchdog: env PI_CMDER_* → пороги (lazy singleton; невалидные значения молча игнорируются),
// конструктор-override сильнее env. Блок стоит до первого new Watchdog() в этом файле.
process.env.PI_CMDER_TICK_MS = "1234";
process.env.PI_CMDER_MAX_NUDGES = "7";
process.env.PI_CMDER_SETTLED_MS = "555";
process.env.PI_CMDER_NU_IDLE_MS = "не-число";
process.env.PI_CMDER_NU_INTERVAL_MS = "12.5";
process.env.PI_CMDER_RECENT_WINDOW = "";
process.env.PI_CMDER_HARD_IDLE_MS = "0"; // 0 = каждый тик эскалировать; должно игнорироваться
const wdEnv = new Watchdog();
assert.equal(wdEnv.C.tickMs, 1234, "env: TICK_MS применён");
assert.equal(wdEnv.C.maxNudges, 7, "env: MAX_NUDGES применён");
assert.equal(wdEnv.C.settledMs, 555, "env: SETTLED_MS применён");
assert.equal(wdEnv.C.nuIdleMs, WD.nuIdleMs, "env: невалидное значение → дефолт");
assert.equal(wdEnv.C.nuIntervalMs, WD.nuIntervalMs, "env: дробное значение → дефолт");
assert.equal(wdEnv.C.hardIdleMs, WD.hardIdleMs, "env: 0 → дефолт (нулевой порог запрещён)");
assert.equal(wdEnv.C.recentWindow, WD.recentWindow, "env: пустое значение → дефолт");
assert.equal(wdConfig(), wdConfig(), "env: пороги читаются один раз (lazy singleton)");
const wdPrio = new Watchdog({ tickMs: 42, maxNudges: 1 });
assert.equal(wdPrio.C.tickMs, 42, "конструктор-override сильнее env: tickMs");
assert.equal(wdPrio.C.maxNudges, 1, "конструктор-override сильнее env: maxNudges");
assert.equal(wdPrio.C.settledMs, 555, "конструктор-override: без override берётся env");
for (const k of ["PI_CMDER_TICK_MS", "PI_CMDER_MAX_NUDGES", "PI_CMDER_SETTLED_MS", "PI_CMDER_NU_IDLE_MS", "PI_CMDER_NU_INTERVAL_MS", "PI_CMDER_RECENT_WINDOW", "PI_CMDER_HARD_IDLE_MS"])
	delete process.env[k];

// watchdog: без прогресса → nudge → авто-эскалация; есть прогресс → тишина
const wdcwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd-"));
const wdir = path.join(wdcwd, ".pi", "pipeline", "T-wd");
fs.mkdirSync(path.join(wdir, "round-1"), { recursive: true });
const wtask: TaskState = {
	id: "T-wd", dir: wdir, base_head: null, cwd: wdcwd, round: 1, stage: "worker", max_rounds: 3,
	history: [], agents: { worker: "w1" }, started_at: "", stage_started_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(wdir, "state.json"), JSON.stringify(wtask));
const wd = new Watchdog({ nuIdleMs: 0, nuIntervalMs: 0, hardIdleMs: 400, stageHardMs: 1e9, recentWindow: 5 });
const wactor: Agent = { name: "w1", role: "worker", surface: { kind: "rpc" } };
const sent: string[] = [];
const noted: string[] = [];
const whooks = { alive: () => true, sendTo: (_a: Agent, l: string) => sent.push(l), notify: (t: string) => noted.push(t), settledAgo: () => null as number | null, sessionDir: () => null, actors: () => [wactor], plannerOf: () => null };
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wd.tick(wdcwd, whooks); // инициализация наблюдения
await sleepMs(5);
await wd.tick(wdcwd, whooks); // прогресса нет → nudge №1
assert.equal(sent.length, 1, "watchdog: nudge №1 отправлен");
assert.ok(sent[0].includes("watchdog") && sent[0].includes("done-worker") && sent[0].includes("ask-worker.md"), "watchdog: в nudge'е выходы (done/ask)");
await sleepMs(5);
await wd.tick(wdcwd, whooks); // → nudge №2 (максимум)
assert.equal(sent.length, 2, "watchdog: nudge №2 отправлен");
await sleepMs(500); // > hardIdleMs
await wd.tick(wdcwd, whooks); // → авто-эскалация, без новых сообщений
assert.equal(sent.length, 2, "watchdog: после эскалации nudge'ов нет");
assert.equal(noted.length, 1, "watchdog: эскалация уведомлена");
assert.ok(noted[0].includes("WATCHDOG") && noted[0].includes("T-wd"), "watchdog: текст эскалации");
assert.equal(readState(wdcwd, "T-wd")?.stage, "escalated", "watchdog: stage=escalated на диске");
assert.ok(readEscalation(wtask), "watchdog: .escalate-файл с причиной");
await wd.tick(wdcwd, whooks); // после эскалации — тишина
assert.equal(noted.length, 1, "watchdog: дублей эскалации нет");

// watchdog: файл изменился = прогресс, nudge не шлётся
const wdcwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd2-"));
const wdir2 = path.join(wdcwd2, ".pi", "pipeline", "T-wd2");
fs.mkdirSync(path.join(wdir2, "round-1"), { recursive: true });
const wtask2: TaskState = { ...wtask, id: "T-wd2", dir: wdir2, cwd: wdcwd2 };
fs.writeFileSync(path.join(wdir2, "state.json"), JSON.stringify(wtask2));
const sent2: string[] = [];
const whooks2 = { ...whooks, sendTo: (_a: Agent, l: string) => sent2.push(l) };
await wd.tick(wdcwd2, whooks2); // инициализация (другая задача — отдельное состояние)
fs.writeFileSync(path.join(wdir2, "round-1", "worker-report.md"), "прогресс");
await sleepMs(5);
await wd.tick(wdcwd2, whooks2); // новая сигнатура = прогресс → не нуджим
assert.equal(sent2.length, 0, "watchdog: прогресс (новый файл) — nudge не шлётся");
assert.notEqual(await taskSignature({ ...wtask2 }), "", "taskSignature: строка");

// watchdog: правка содержимого существующего файла в каталоге задачи = новая сигнатура
const wfile = path.join(wdir2, "round-1", "worker-report.md");
const sigSame = await taskSignature({ ...wtask2 });
await sleepMs(5);
fs.writeFileSync(wfile, "прогресс: дописал ещё работу"); // содержимое изменилось, новых файлов нет
assert.notEqual(await taskSignature({ ...wtask2 }), sigSame, "taskSignature: правка содержимого меняет сигнатуру");

// watchdog: «пинг-понг» тем же содержимым (та же сигнатура) — прогрессом не считается
const wdcwd4 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd4-"));
const wdir4 = path.join(wdcwd4, ".pi", "pipeline", "T-pp");
fs.mkdirSync(path.join(wdir4, "round-1"), { recursive: true });
const wtask4: TaskState = { ...wtask, id: "T-pp", dir: wdir4, cwd: wdcwd4 };
fs.writeFileSync(path.join(wdir4, "state.json"), JSON.stringify(wtask4));
const sent4: string[] = [];
const whooks4 = { ...whooks, sendTo: (_a: Agent, l: string) => sent4.push(l) };
const wdp = new Watchdog({ nuIdleMs: 0, nuIntervalMs: 0, hardIdleMs: 1e9, stageHardMs: 1e9, recentWindow: 10 });
const ppFile = path.join(wdir4, "round-1", "worker-report.md");
const stamp = new Date("2024-01-01T00:00:00Z");
const writeSame = () => {
	fs.writeFileSync(ppFile, "одно и то же содержимое");
	fs.utimesSync(ppFile, stamp, stamp); // фиксированные mtime/size → сигнатура не меняется
};
await wdp.tick(wdcwd4, whooks4); // инициализация наблюдения
writeSame();
await sleepMs(5);
await wdp.tick(wdcwd4, whooks4); // файл создан → новая сигнатура = прогресс
assert.equal(sent4.length, 0, "ping-pong: новая сигнатура — прогресс, nudge нет");
writeSame();
await sleepMs(5);
await wdp.tick(wdcwd4, whooks4); // сигнатура уже была в окне → не прогресс → nudge
assert.equal(sent4.length, 1, "ping-pong: то же содержимое — прогрессом не считается");

// watchdog: rpc-актёр завершил turn, а done-файла нет → нюдж без idle-порога,
// а после исчерпания нюджей — эскалация (иначе «забыл финальный шаг» висит до 3 ч)
const wdcwd5 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd5-"));
const wdir5 = path.join(wdcwd5, ".pi", "pipeline", "T-settled");
fs.mkdirSync(path.join(wdir5, "round-1"), { recursive: true });
const wtask5: TaskState = { ...wtask, id: "T-settled", dir: wdir5, cwd: wdcwd5 };
fs.writeFileSync(path.join(wdir5, "state.json"), JSON.stringify(wtask5));
const sent5: string[] = [];
const noted5: string[] = [];
const whooks5 = { ...whooks, sendTo: (_a: Agent, l: string) => sent5.push(l), notify: (t: string) => noted5.push(t), settledAgo: () => 10 * 60_000 };
const wds = new Watchdog({ nuIdleMs: 1e9, nuIntervalMs: 0, hardIdleMs: 1e9, stageHardMs: 1e9, maxNudges: 1, settleStuckMs: 60_000 });
await wds.tick(wdcwd5, whooks5); // инициализация
await wds.tick(wdcwd5, whooks5); // settled 10 мин, done-файла нет → нюдж, idle-порог (1e9) не ждём
assert.equal(sent5.length, 1, "settled: нюдж без idle-порога");
assert.ok(sent5[0].includes("done-worker") && sent5[0].includes("turn уже завершён"), "settled: в нюдже финальный шаг и признак завершённого turn");
await wds.tick(wdcwd5, whooks5); // нюджи исчерпаны → эскалация
assert.equal(noted5.length, 1, "settled: после исчерпания нюджей — эскалация");
assert.ok(noted5[0].includes("WATCHDOG") && readState(wdcwd5, "T-settled")?.stage === "escalated", "settled: stage=escalated");
// тот жеsettled, но done-файл есть — тишина (работа сделана)
const wdcwd6 = fs.mkdtempSync(path.join(os.tmpdir(), "commander-wd6-"));
const wdir6 = path.join(wdcwd6, ".pi", "pipeline", "T-settled-ok");
fs.mkdirSync(path.join(wdir6, "round-1"), { recursive: true });
fs.writeFileSync(path.join(wdir6, "state.json"), JSON.stringify({ ...wtask5, id: "T-settled-ok", dir: wdir6, cwd: wdcwd6 }));
fs.writeFileSync(path.join(wdir6, "round-1", "done-worker"), "");
const sent6: string[] = [];
const wds2 = new Watchdog({ nuIdleMs: 1e9, nuIntervalMs: 0, hardIdleMs: 1e9, stageHardMs: 1e9, maxNudges: 1, settleStuckMs: 60_000 });
await wds2.tick(wdcwd6, { ...whooks5, sendTo: (_a: Agent, l: string) => sent6.push(l), notify: () => {} });
await wds2.tick(wdcwd6, { ...whooks5, sendTo: (_a: Agent, l: string) => sent6.push(l), notify: () => {} });
assert.equal(sent6.length, 0, "settled: done-файл есть — нюджа нет");

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
const whooks3 = { alive: () => true, sendTo: (_a: Agent, l: string) => sent3.push(l), notify: (t: string) => noted3.push(t), settledAgo: () => null as number | null, sessionDir: () => sessDir, actors: () => [wactor], plannerOf: () => null };
// в сессии снова только read-loop (обновим хвост без мутаций)
fs.writeFileSync(sessFile, Array.from({ length: 20 }, () => toolLine("read", { path: "/proj/INSTRUCTIONS.md" })).join("\n") + "\n");
await wd.tick(wdcwd3, whooks3); // инициализация
await wd.tick(wdcwd3, whooks3); // loop сразу → nudge №1 (idle-пороги 15/45 мин не ждут)
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

// scheduler: tickQueue на фейковом транспорте (без tmux/rpc) — запуск из очереди
// до pass и эскалация при мёртвом агенте. Шов AgentPool — цель выноса scheduler.ts.
{
	const { tickQueue } = await import("../scheduler.ts");
	const { saveRegistry } = await import("../registry.ts");
	const scwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-sched-"));
	const mkTask = (id: string, agents: Record<string, string>) => {
		const dir = path.join(scwd, ".pi", "pipeline", id);
		fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });
		const t: TaskState = { id, dir, base_head: null, cwd: scwd, round: 1, stage: "queued", max_rounds: 3, history: [], agents: agents as TaskState["agents"], started_at: "", stage_started_at: new Date().toISOString() };
		fs.writeFileSync(path.join(dir, "spec.md"), "# S\n## Критерии приёмки\n- x\n");
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(t));
		return t;
	};
	// фейк-агент: на бриф пишет артефакт + done, вердикт всегда pass
	const mkPool = (dead: string[] = []): import("../scheduler.ts").AgentPool => ({
		ensure: () => {},
		alive: (a) => !dead.includes(a.name),
		sendTo: (a, line) => {
			const rd = path.join(scwd, ".pi", "pipeline", line.match(/T-s\d/)![0], line.match(/round-\d+/)![0]);
			fs.mkdirSync(rd, { recursive: true });
			if (a.role === "worker") {
				fs.writeFileSync(path.join(rd, "worker-report.md"), "# r\n## Статус: done\n");
				fs.writeFileSync(path.join(rd, "done-worker"), "");
			} else if (a.role === "planner") {
				fs.writeFileSync(path.join(rd, "planner-decision.md"), "# r\n## Требования: нет\n");
				fs.writeFileSync(path.join(rd, "done-planner"), "");
			} else {
				fs.writeFileSync(path.join(rd, "judge-verdict.json"), JSON.stringify({ verdict: "pass", issues: [] }));
				fs.writeFileSync(path.join(rd, "done-judge"), "");
			}
		},
		spawnSliceWorker: async () => { throw new Error("не для этого теста"); },
		killAgent: () => {},
	});
	const reg3 = (w: string) => ({ agents: [
		{ name: w, role: "worker" as const, surface: { kind: "tmux" as const, target: "%1" } },
		{ name: "sp", role: "planner" as const, surface: { kind: "tmux" as const, target: "%2" } },
		{ name: "sj", role: "judge" as const, surface: { kind: "tmux" as const, target: "%3" } },
	] });
	saveRegistry(scwd, reg3("sw"));
	mkTask("T-s1", { worker: "sw", planner: "sp", judge: "sj" });
	const escalated: string[] = [];
	const schedDeps = (pool: import("../scheduler.ts").AgentPool, launched: Set<string>) =>
		({ cwd: scwd, pool, launched, notify: () => {}, escalate: (t: TaskState, r: string) => { escalated.push(`${t.id}:${r}`); (t as any).stage = "escalated"; (t as any).notes = r; fs.writeFileSync(path.join(t.dir, "state.json"), JSON.stringify(t)); } });
	tickQueue(schedDeps(mkPool(), new Set()));
	// ждём завершения фонового runTask (фейки пишут артефакты синхронно — секунды)
	let stage = "";
	for (let k = 0; k < 100; k++) {
		stage = readState(scwd, "T-s1")?.stage ?? "";
		if (stage === "done" || stage === "escalated") break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.equal(stage, "done", "scheduler: очередь запустила живую задачу, цикл дошёл до pass");
	// judge мёртв → эскалация без запуска
	mkTask("T-s2", { worker: "sw", planner: "sp", judge: "sj" });
	tickQueue(schedDeps(mkPool(["sj"]), new Set()));
	assert.ok(escalated.some((e) => e.startsWith("T-s2:очередь:")), "scheduler: мёртвый агент → эскалация");
	assert.equal(readState(scwd, "T-s2")?.stage, "escalated", "scheduler: снята с очереди эскалацией");
	// уже запущенная (launched) не переэскалируется и не стартует второй раз
	mkTask("T-s3", { worker: "sw", planner: "sp", judge: "sj" });
	tickQueue(schedDeps(mkPool(["sj"]), new Set(["T-s3"])));
	assert.equal(readState(scwd, "T-s3")?.stage, "queued", "scheduler: launched-задача не тронута");
	// конфликт-чек: агенты заняты другой активной задачей → остаётся в очереди
	const busyDir = path.join(scwd, ".pi", "pipeline", "T-busy");
	fs.mkdirSync(path.join(busyDir, "round-1"), { recursive: true });
	const busyTask: TaskState = { ...JSON.parse(fs.readFileSync(path.join(scwd, ".pi", "pipeline", "T-s2", "state.json"), "utf8")), id: "T-busy", dir: busyDir, stage: "worker", notes: "" };
	fs.writeFileSync(path.join(busyDir, "state.json"), JSON.stringify(busyTask));
	mkTask("T-s4", { worker: "sw", planner: "sp", judge: "sj" });
	tickQueue(schedDeps(mkPool(), new Set()));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(readState(scwd, "T-s4")?.stage, "queued", "scheduler: занятые агенты — ждём освобождения");
	fs.rmSync(scwd, { recursive: true });
}

console.log("selfcheck: OK");
