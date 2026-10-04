/**
 * RPC-агент: `pi --mode rpc` как дочерний процесс conductor'а.
 * Протокол: JSONL на stdin (команды) / stdout (response + события).
 * Done-контракт тот же (done-файлы), agent_settled — только для health.
 */
import { spawn, type ChildProcess } from "node:child_process";

export class RpcAgent {
	alive = true;
	ready = false;
	private proc: ChildProcess;
	private seq = 0;
	private lastSettledAt: string | null = null;
	lastError: string | null = null;

	constructor(private opts: { cwd: string; model?: string; bin?: string }) {
		const args = ["--mode", "rpc"];
		if (opts.model) args.push("--model", opts.model);
		this.proc = spawn(opts.bin ?? "pi", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\n")) {
				const l = line.trim();
				if (!l) continue;
				try {
					const rec = JSON.parse(l);
					if (rec.type === "agent_settled") {
						this.ready = true;
						this.lastSettledAt = new Date().toISOString();
					}
					if (rec.type === "response" && rec.success === false) {
						this.lastError = rec.error ?? "rpc error";
					}
				} catch {
					// не наш формат — пропускаем (stdout должен только сливаться)
				}
			}
		});
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const s = chunk.toString().trim();
			if (s) this.lastError = s.slice(-200);
		});
		this.proc.on("exit", () => {
			this.alive = false;
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

	get lastSettled(): string | null {
		return this.lastSettledAt;
	}

	kill(): void {
		try {
			this.proc.kill("SIGTERM");
		} catch {}
	}
}
