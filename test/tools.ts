/**
 * Дым-тест инструментов index.ts на фейковом pi-хосте (формат пользовательских
 * строк, конфликт-чек, abort/remove). Транспорта нет: tmux-панели несуществующие,
 * живость = false — этого хватает, чтобы прогнать выборки и форматирование.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveRegistry } from "../registry.ts";
import { readState, type TaskState } from "../state.ts";

const { default: commander } = await import("../index.ts");
const tools = new Map<string, { execute: (id: string, p: never, signal: never, u: never, ctx: { cwd: string }) => Promise<{ content: [{ text: string }] }> }>();
commander({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => {} } as never);
const out = async (name: string, p: object) => (await tools.get(name)!.execute("x", p as never, undefined as never, undefined as never, { cwd })).content[0].text;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commander-tools-"));
const mk = (id: string, stage: TaskState["stage"]) => {
	const dir = path.join(cwd, ".pi", "pipeline", id);
	fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });
	const at = new Date(Date.now() - 120_000).toISOString();
	const t: TaskState = {
		id, dir, base_head: null, cwd, round: 1, stage, max_rounds: 3,
		history: [{ round: 1, verdict: "revise", issues: [{ id: "I1", sev: "major", what: "x" }] }],
		agents: { worker: "w1", planner: "p1", judge: "j1" }, started_at: at, stage_started_at: at,
	};
	fs.writeFileSync(path.join(dir, "spec.md"), "# s\n## Критерии приёмки\n- x\n");
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(t));
};
saveRegistry(cwd, {
	agents: (["w1:worker", "p1:planner", "j1:judge", "x1:judge"] as const).map((s) => {
		const [name, role] = s.split(":");
		return { name, role: role as "worker" | "planner" | "judge", surface: { kind: "tmux" as const, target: "%nope" } };
	}),
});
mk("T-a", "worker");
mk("T-q", "queued");

const status = await out("pipeline_status", {});
assert.ok(status.includes("T-a: stage=worker") && status.includes("мин в этапе"), "status: активная задача с возрастом этапа");
assert.ok(status.includes("round 1: revise (1 issues)"), "status: история вердиктов");
assert.ok(status.includes("T-q") && status.includes("ждёт: w1: T-a"), "status: очередь видит, какого агента ждёт");

const reg = await out("pipeline_agents", {});
assert.ok(reg.includes("w1 — worker, tmux %nope") && reg.includes("МЁРТВ"), "agents: реестр с живостью");
assert.ok(reg.includes("занят: T-a"), "agents: занятость в задаче");

assert.ok((await out("pipeline_remove", { name: "x1" })).includes("удалён: x1"), "remove: свободный агент удалён");
assert.ok(!(await out("pipeline_agents", {})).includes("x1"), "remove: его нет в реестре");
assert.ok((await out("pipeline_remove", { name: "j1" })).includes("пропущен j1"), "remove: занятого без force не трогаем");

assert.ok((await out("pipeline_abort", { id: "T-a" })).includes("Aborted: T-a"), "abort: остановил задачу");
assert.equal(readState(cwd, "T-a")?.stage, "aborted", "abort: stage=aborted на диске");
assert.ok((await out("pipeline_status", {})).includes("Активных нет"), "status: после abort активных нет");
assert.ok(!(await out("pipeline_status", {})).includes("ждёт: w1"), "status: остановленная задача больше не держит агентов");

console.log("tools: OK");
