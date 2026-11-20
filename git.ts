/** Минимальный git-слой для sliced-режима (worktrees, merge) и проверок запуска. */
import { execFile, execFileSync } from "node:child_process";

export function git(cwd: string, ...args: string[]): string {
	// stderr не льём в консоль pi (шум «fatal: not a git repository» и пр.);
	// при ошибке он всё равно попадёт в message брошенного исключения
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
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

/** Сигнатура рабочего дерева для watchdog'а: status + diff --stat, без обрезки
 * (обрезка до 4 КБ теряла «хвост» больших репо → активная работа выглядела простоем).
 * Асинхронно: watchdog дёргает это каждые 30 с на каждую задачу, синхронный execFileSync
 * морозил event loop conductor'а. Любая ошибка git = пустая строка (как «не репо»). */
export function statusSig(cwd: string): Promise<string> {
	const run = (args: string[]) =>
		new Promise<string>((res) => execFile("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (_e, so) => res(_e ? "" : so)));
	return Promise.all([run(["status", "--porcelain"]), run(["diff", "--stat", "HEAD"])]).then(([st, ds]) => st + "\n" + ds);
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

/** Merge ветки в основное дерево. Конфликт и ошибка окружения — разные исходы;
 *  при любом неуспехе пробуем merge --abort, чтобы не оставить репо в MERGING
 *  (иначе следующие sliced-задачи блокируются проверкой isClean). */
export type MergeResult = { ok: true } | { ok: false; conflict: boolean; error: string };
export function merge(cwd: string, branch: string, msg: string): MergeResult {
	try {
		git(cwd, "merge", "--no-ff", "-m", msg, branch);
		return { ok: true };
	} catch (e) {
		const em = e as { stderr?: unknown; message?: string };
		const err = `${em.stderr ? String(em.stderr) : ""} ${em.message ?? String(e)}`;
		const conflict = /conflict|unmerged/i.test(err);
		try {
			git(cwd, "merge", "--abort");
		} catch {}
		return { ok: false, conflict, error: err.replace(/\s+/g, " ").slice(0, 300) };
	}
}
