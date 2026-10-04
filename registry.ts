/** Реестр зарегистрированных агентов: .pi/pipeline/registry.json */
import fs from "node:fs";
import path from "node:path";
import { PIPELINE_DIR } from "./state.ts";
import type { Agent, Role } from "./state.ts";

export interface Registry {
	agents: Agent[];
}

export function loadRegistry(cwd: string): Registry {
	try {
		return JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR(cwd), "registry.json"), "utf8"));
	} catch {
		return { agents: [] };
	}
}

export function saveRegistry(cwd: string, r: Registry): void {
	const dir = PIPELINE_DIR(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(r, null, 2));
}
