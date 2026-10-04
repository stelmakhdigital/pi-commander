/** Минимальный tmux-слой: одна строка в пань + проверка живости. */
import { execFileSync } from "node:child_process";

export function tmux(...args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Только ОДНА строка: многострочный ввод ломает TUI (каждый \n = отправка).
 * Многострочный контент кладётся в brief-файл, в пань — строка-указатель.
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
