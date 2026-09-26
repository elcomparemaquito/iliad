import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { AgentRuntimeError } from "./errors.js";

export function codexError(code: "provider_unavailable" | "rate_limited" | "invalid_api_key" | "request_timeout" | "malformed_provider_response" = "provider_unavailable") {
  return new AgentRuntimeError({ code, userMessage: `Codex: ${code}`, retryable: code !== "invalid_api_key" });
}

/** Private JSONL transport. Never forwards server messages or stderr to logs/UI. */
export class CodexTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private stopped = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.child = spawn(executable, args, { ...options, windowsHide: true, shell: false, stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.on("error", () => this.stop());
    this.child.on("exit", () => this.stop());
    this.child.stdin.on("error", () => this.stop());
  }
  request(method: string, params: unknown = {}, timeout = 15000): Promise<any> {
    if (this.stopped) return Promise.reject(codexError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(codexError("request_timeout")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string) { this.send({ method }); }
  private send(message: unknown) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) { this.stop(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          // The writing adapter exposes no client tools or approval surface.
          this.send({ id: message.id, error: { code: -32601, message: "Unsupported in writing mode" } });
          this.emit("unsafeRequest");
        } else if (message.method) this.emit("notification", message.method, message.params);
        else {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(codexError()); else pending.resolve(message.result);
        }
      } catch { this.stop(); return; }
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(codexError()); }
    this.pending.clear();
    this.child.kill();
    this.emit("closed");
  }
}
