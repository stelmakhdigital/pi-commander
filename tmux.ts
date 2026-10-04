/** Минимальный tmux-слой: строка в панель, живость, создание панелей. */
import { execFileSync } from "node:child_process";

export function tmux(...args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Только ОДНА строка: многострочный ввод ломает TUI (каждый \n = отправка).
 * Многострочный контент кладётся в brief-файл, в панель — строка-указатель.
 */
export function sendLine(pane: string, line: string): void {
	tmux("send-keys", "-t", pane, "-l", line.replace(/\n/g, " "));
	tmux("send-keys", "-t", pane, "Enter");
}

export function isAlive(pane: string): boolean {
	try {
		tmux("list-panes", "-t", pane, "-F", "#{pane_id}");
		return true;
	} catch {
		return false;
	}
}

/** Новая detached-панель, запускающая command (например `pi '<bootstrap>'`). Возвращает pane id. */
export function createPane(sourcePane: string, command?: string): string {
	const out = tmux("split-window", "-d", "-t", sourcePane, "-P", "-F", "#{pane_id}", ...(command ? [command] : []));
	if (!out.startsWith("%")) throw new Error(`unexpected tmux output: ${out}`);
	// Равномерная пересборка: иначе каждый split берёт половину предыдущей панели.
	tmux("select-layout", "-t", sourcePane, "tiled");
	return out;
}
