/** Минимальный git-слой для sliced-режима (worktrees, merge) и проверок запуска. */
import { execFileSync } from "node:child_process";

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function isRepo(cwd: string): boolean {
	try {
		git(cwd, "rev-parse", "--git-dir");
		return true;
	} catch {
		return false;
	}
}

export function head(cwd: string): string | null {
	try {
		return git(cwd, "rev-parse", "HEAD");
	} catch {
		return null;
	}
}

export function isClean(cwd: string): boolean {
	try {
		return git(cwd, "status", "--porcelain") === "";
	} catch {
		return false;
	}
}

export const sliceBranch = (id: string, round: number, name: string) => `pipeline/${id}/r${round}-${name.replace(/[^\w.-]/g, "")}`;

export function worktreeAdd(cwd: string, wt: string, branch: string, base: string): void {
	git(cwd, "worktree", "add", "-q", wt, "-b", branch, base);
}

export function worktreeRemove(cwd: string, wt: string): void {
	try {
		git(cwd, "worktree", "remove", "--force", wt);
	} catch {}
}

export function branchDelete(cwd: string, branch: string): void {
	try {
		git(cwd, "branch", "-D", branch);
	} catch {}
}

/** Закоммитить всё в worktree (пусть и пустое — merge не упрётся). */
export function commitAll(wt: string, msg: string): void {
	git(wt, "add", "-A");
	git(wt, "commit", "-q", "--allow-empty", "-m", msg);
}

/** Merge ветки в основное дерево. false = конфликт. */
export function merge(cwd: string, branch: string, msg: string): boolean {
	try {
		git(cwd, "merge", "--no-ff", "-m", msg, branch);
		return true;
	} catch {
		return false;
	}
}
