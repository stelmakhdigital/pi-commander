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

/** Новое detached-окно в той же сессии, запускающее command (например `pi '<bootstrap>'`).
 *  Имя окна = name. Возвращает id единственной панели окна. */
export function createWindow(sourcePane: string, name: string, command?: string): string {
	// new-window требует окно/сессию, не панель — берём session id панели.
	const session = tmux("display-message", "-p", "-t", sourcePane, "#{session_id}");
	const wid = tmux("new-window", "-d", "-t", session, "-n", name, "-P", "-F", "#{window_id}", ...(command ? [command] : []));
	if (!wid.startsWith("@")) throw new Error(`unexpected tmux output: ${wid}`);
	const pane = tmux("list-panes", "-t", wid, "-F", "#{pane_id}").split("\n")[0].trim();
	if (!pane.startsWith("%")) throw new Error(`unexpected pane id: ${pane}`);
	return pane;
}
