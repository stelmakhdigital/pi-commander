/** E2E sliced-режима: decompose → 2 slice-воркера параллельно в worktrees → merge → planner∥judge → pass. Запуск: npm run test:e2e:slices */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTask, type Agent, type TaskState } from "../state.ts";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "commander-slices-"));
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
g("init", "-q", "-b", "main");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "base.txt"), "base");
g("add", "-A");
g("commit", "-q", "-m", "base");
const head = g("rev-parse", "HEAD").trim();

const dir = path.join(repo, ".pi", "pipeline", "T-slices");
fs.mkdirSync(path.join(dir, "round-1"), { recursive: true });

const task: TaskState = {
	id: "T-slices", dir, base_head: head, cwd: repo, round: 1, stage: "worker", max_rounds: 3,
	history: [], agents: { worker: "w", planner: "p", judge: "j" }, mode: "sliced", slice_count: 2, started_at: "",
};

const agents: Agent[] = [
	{ name: "w", role: "worker", surface: { kind: "rpc" } },
	{ name: "p", role: "planner", surface: { kind: "tmux", target: "%2" } },
	{ name: "j", role: "judge", surface: { kind: "tmux", target: "%3" } },
];

const killed: string[] = [];
const briefPath = (line: string) => line.match(/Прочитай (\S+)/)![1];

// Фейковые агенты: decompose → slices.json; slice-воркер пишет код в свой worktree (путь из brief) + done; judge → pass.
const sendTo = (a: Agent, line: string) => {
	const bf = briefPath(line);
	const rd = path.dirname(bf);
	const content = fs.readFileSync(bf, "utf8");
	if (line.includes("brief-decompose")) {
		fs.writeFileSync(path.join(rd, "slices.json"), JSON.stringify([
			{ name: "sa", scope: "sa.txt", brief: "Создай sa.txt" },
			{ name: "sb", scope: "sb.txt", brief: "Создай sb.txt" },
		]));
		fs.writeFileSync(path.join(rd, "done-decompose"), "");
	} else if (line.includes("brief-slice")) {
		const wt = content.match(/Каталог работы \(git worktree\): (.+)\n/)![1];
		const name = content.match(/Твой слайс: (\S+) —/)![1];
		fs.writeFileSync(path.join(wt, `${name}.txt`), name);
		fs.writeFileSync(path.join(rd, "worker-report.md"), "# slice report\n");
		fs.writeFileSync(path.join(rd, "done-worker"), "");
	} else if (line.includes("brief-planner")) {
		fs.writeFileSync(path.join(rd, "planner-decision.md"), "# planner\n");
		fs.writeFileSync(path.join(rd, "done-planner"), "");
	} else if (line.includes("brief-judge")) {
		fs.writeFileSync(path.join(rd, "judge-verdict.json"), JSON.stringify({ verdict: "pass", issues: [] }));
		fs.writeFileSync(path.join(rd, "done-judge"), "");
	}
};

await runTask(task, {
	agents,
	sendTo,
	alive: () => true,
	notify: () => {},
	spawnSliceWorker: async (_t, s) => ({ name: `${task.id}/${s.name}`, role: "worker", surface: { kind: "rpc" } }),
	killAgent: (a) => killed.push(a.name),
});

assert.equal(task.stage, "done", `stage=${task.stage}: ${task.notes}`);
assert.equal(task.history[0].verdict, "pass", "judge pass за 1 раунд");
assert.ok(fs.existsSync(path.join(repo, "sa.txt")) && fs.existsSync(path.join(repo, "sb.txt")), "код слайсов merge-нут в основное дерево");
assert.ok(!fs.existsSync(path.join(dir, "worktrees", "sa")), "worktrees почищены");
assert.ok(!g("branch", "--format=%(refname:short)").includes("pipeline/"), "slice-ветки удалены");
assert.equal(killed.length, 2, "slice-агенты убиты");
console.log("e2e-slices: OK");
