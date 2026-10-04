/** Реестр зарегистрированных агентов: .pi/pipeline/registry.json */
import fs from "node:fs";
import path from "node:path";
import { PIPELINE_DIR, normalizeAgent, type Agent, type Role } from "./state.ts";

export interface Registry {
	agents: Agent[];
}

export function loadRegistry(cwd: string): Registry {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR(cwd), "registry.json"), "utf8"));
		return { agents: (raw.agents as Array<Record<string, unknown>>).map(normalizeAgent).filter((a): a is Agent => !!a) };
	} catch {
		return { agents: [] };
	}
}

export function saveRegistry(cwd: string, r: Registry): void {
	const dir = PIPELINE_DIR(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(r, null, 2));
}

/** Агенты по ролям (для дефолтного набора задачи; разрешено несколько на роль). */
export function agentsByRole(reg: Registry): Partial<Record<Role, Agent[]>> {
	const out: Partial<Record<Role, Agent[]>> = { worker: [], planner: [], judge: [] };
	for (const a of reg.agents) out[a.role]?.push(a);
	return out;
}
