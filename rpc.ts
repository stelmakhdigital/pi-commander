/**
 * RPC-агент: `pi --mode rpc` как дочерний процесс conductor'а.
 * Протокол: JSONL на stdin (команды) / stdout (response + события).
 * Done-контракт тот же (done-файлы), agent_settled — только для health.
 * Сессия — в собственном --session-dir (иначе --continue взял бы чужую
 * последнюю сессию проекта). При раннем сходе с --continue — один рестарт без него.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RpcAgentOptions {
	cwd: string;
	model?: string;
	bin?: string;
	/** Каталог сессий агента (изолирует --continue от других сессий проекта). */
	sessionDir?: string;
	/** Продолжить последнюю сессию агента (память о прошлых задачах). */
	resume?: boolean;
}

export class RpcAgent {
	alive = true;
	lastError: string | null = null;
	lastSettledAt: string | null = null;
	private proc!: ChildProcess;
	private seq = 0;
	private startedAt = 0;
	private retried = false;
	private opts: RpcAgentOptions;

	constructor(opts: RpcAgentOptions) {
		this.opts = opts;
		this.spawnProc();
	}

	private spawnProc(): void {
		const args = ["--mode", "rpc"];
		if (this.opts.sessionDir) args.push("--session-dir", this.opts.sessionDir);
		if (this.opts.resume) args.push("--continue");
		if (this.opts.model) args.push("--model", this.opts.model);
		this.startedAt = Date.now();
		this.proc = spawn(this.opts.bin ?? "pi", args, { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\n")) {
				const l = line.trim();
				if (!l) continue;
				try {
					const rec = JSON.parse(l);
					if (rec.type === "agent_settled") this.lastSettledAt = new Date().toISOString();
					if (rec.type === "response" && rec.success === false) this.lastError = rec.error ?? "rpc error";
				} catch {
					// не наш формат — пропускаем (stdout должен только сливаться)
				}
			}
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const s = chunk.toString().trim();
			if (s) this.lastError = s.slice(-200);
		});
		this.proc.on("exit", (code) => {
			this.alive = false;
			// Ранний сход с --continue (вероятно, сессий ещё не было) — один рестарт без resume.
			if (code !== 0 && this.opts.resume && !this.retried && Date.now() - this.startedAt < 5000) {
				this.retried = true;
				this.opts = { ...this.opts, resume: false };
				this.alive = true;
				this.spawnProc();
			}
		});
		this.proc.on("error", (e) => {
			this.alive = false;
			this.lastError = e.message;
		});
	}

	/** Отправить сообщение (аналог send-keys для tmux). Можно и многострочное. */
	prompt(text: string): void {
		if (!this.alive) throw new Error("rpc agent dead");
		const id = `cmd-${++this.seq}`;
		this.proc.stdin?.write(JSON.stringify({ id, type: "prompt", message: text }) + "\n");
	}

	kill(): void {
		try {
			this.proc.kill("SIGTERM");
		} catch {}
	}
}
