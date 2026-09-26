import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const control = vi.hoisted(() => ({ connected: true, answer: '{"text":"Texto corregido."}', status: "completed", hang: false, unsafe: false, calls: [] as Array<{ method: string; params: any }>, version: "codex-cli 0.154.0", configMismatch: false }));
vi.mock("node:child_process", () => ({ execFile: (...args: any[]) => args.at(-1)(null, { stdout: control.version }) }));
vi.mock("../../electron/writing/codexTransport", async importOriginal => {
  const original = await importOriginal<typeof import("../../electron/writing/codexTransport")>();
  return { ...original, CodexTransport: class extends EventEmitter {
    notify() {}
    stop() { this.emit("closed"); }
    async request(method: string, params: any) {
      control.calls.push({ method, params });
      if (method === "config/read") {
        const { writingConfig } = await import("../../electron/writing/codexProvider");
        const config: any = {};
        for (const [key, value] of Object.entries(writingConfig)) { const parts = key.split('.'); let target = config; for (const part of parts.slice(0,-1)) target = target[part] ??= {}; target[parts.at(-1)!] = value; }
        if (control.configMismatch) config.features.shell_tool = true;
        return { config };
      }
      if (method === "account/read") return { account: control.connected ? { type: "chatgpt" } : null };
      if (method === "model/list") return { data: [{ id: "test-model", displayName: "Test", defaultReasoningEffort: "low", isDefault: true }], nextCursor: null };
      if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 20, resetsAt: 123 } } };
      if (method === "account/login/start") return { loginId: "login", authUrl: "https://auth.openai.com/authorize" };
      if (method === "thread/start") return { thread: { id: "thread" }, sandbox: { type: "readOnly" }, activePermissionProfile: { id: "iliad-writing" }, modelProvider: "openai", approvalPolicy: "never", instructionSources: [] };
      if (method === "turn/start") {
        setTimeout(() => {
          if (control.unsafe) this.emit("unsafeRequest");
          else if (!control.hang) {
            this.emit("notification", "item/completed", { threadId: "thread", item: { type: "agentMessage", text: control.answer } });
            this.emit("notification", "turn/completed", { threadId: "thread", turn: { id: "turn", status: control.status, error: { codexErrorInfo: "usageLimitExceeded" } } });
          }
        }, 5);
        return { turn: { id: "turn" } };
      }
      return {};
    }
  }};
});
import { CodexProvider } from "../../electron/writing/codexProvider";
let root: string;
let provider: CodexProvider;
beforeEach(async () => {
  Object.assign(control, { connected: true, answer: '{"text":"Texto corregido."}', status: "completed", hang: false, unsafe: false, calls: [], version: "codex-cli 0.154.0", configMismatch: false });
  root = await mkdtemp(path.join(os.tmpdir(), "iliad-codex-"));
  provider = new CodexProvider(root, process.execPath);
});
afterEach(async () => { provider.dispose(); await rm(root, { recursive: true, force: true }); });
describe("Codex writing adapter", () => {
  it("discovers account models and limits", async () => {
    expect(await provider.getStatus()).toMatchObject({ state: "connected", model: "test-model", limits: [{ remaining: 80 }] });
  });
  it("fails closed on unsupported versions or overridden restrictions", async () => {
    control.version = "codex-cli 0.155.0";
    expect((await provider.getStatus()).state).toBe("incompatible");
    control.version = "codex-cli 0.154.0"; control.configMismatch = true;
    expect((await provider.getStatus()).state).toBe("incompatible");
  });
  it("uses independent ephemeral read-only turns and returns only final text", async () => {
    expect(await provider.generate("Rewrite", "Example", new AbortController().signal)).toBe("Texto corregido.");
    expect(control.calls.find(c => c.method === "thread/start")?.params).toMatchObject({ ephemeral: true, permissions: "iliad-writing", approvalPolicy: "never" });
    expect(control.calls.find(c => c.method === "turn/start")?.params).toMatchObject({ permissions: "iliad-writing", environments: [] });
  });
  it.each(["", "not json", '{"text":""}', '{"text":123}'])("rejects empty or malformed answers: %s", async answer => {
    control.answer = answer;
    await expect(provider.generate("Rewrite", "Example", new AbortController().signal)).rejects.toMatchObject({ agentError: { code: "malformed_provider_response" } });
  });
  it("reports exhausted usage without exposing provider messages", async () => {
    control.status = "failed";
    await expect(provider.generate("Rewrite", "Example", new AbortController().signal)).rejects.toMatchObject({ agentError: { code: "rate_limited" } });
  });
  it("interrupts a canceled turn", async () => {
    control.hang = true;
    const controller = new AbortController();
    const result = provider.generate("Rewrite", "Example", controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(control.calls.some(c => c.method === "turn/start")).toBe(true));
    controller.abort(); await assertion;
    expect(control.calls.some(c => c.method === "turn/interrupt")).toBe(true);
  });
  it("rejects unexpected tool requests", async () => {
    control.unsafe = true;
    await expect(provider.generate("Rewrite", "Example", new AbortController().signal)).rejects.toThrow();
  });
  it("never starts generation when signed out", async () => {
    control.connected = false;
    await expect(provider.generate("Rewrite", "Example", new AbortController().signal)).rejects.toMatchObject({ agentError: { code: "invalid_api_key" } });
    expect(control.calls.some(c => c.method === "turn/start")).toBe(false);
  });
});
