import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexTransport, codexError } from "./codexTransport.js";
import type { CodexStatus } from "./codexTypes.js";

const exec = promisify(execFile);
export const CODEX_TIMEOUT_MS = 90000;
export const writingConfig: Record<string, unknown> = {
  'permissions.iliad-writing.filesystem.:minimal': "read",
  'permissions.iliad-writing.filesystem.:workspace_roots': "read",
  "permissions.iliad-writing.network.enabled": false,
  default_permissions: "iliad-writing",
  forced_login_method: "chatgpt", cli_auth_credentials_store: "file",
  "history.persistence": "none", web_search: "disabled", project_doc_max_bytes: 0,
  "analytics.enabled": false, "feedback.enabled": false,
  "features.shell_tool": false, "features.unified_exec": false,
  "features.apply_patch_freeform": false, "features.code_mode": false,
  "features.js_repl": false, "features.multi_agent": false, "features.multi_agent_v2": false,
  "features.apps": false, "features.computer_use": false, "features.remote_plugin": false,
  "features.skill_search": false, "features.skill_mcp_dependency_install": false,
  "features.browser_use": false, "features.browser_use_external": false,
  "features.tool_suggest": false, "features.memories": false,
  "features.plugins": false, "features.recommended_plugins": false,
  "features.tool_search": false, "features.search_tool": false,
  "features.view_image": false, "features.imagegenext": false,
  "features.memory_tool": false, "features.request_permissions_tool": false,
  "features.image_generation": false, "features.remote_control": false,
  "features.skip_host_skill_discovery": true, "features.hooks": false,
  "features.codex_hooks": false, "features.plugin_hooks": false,
  "tools.update_plan.enabled": false, mcp_servers: {}, plugins: {}
};

export async function resolveCodexExecutable(configured?: string): Promise<string> {
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, process.platform === "win32" ? "codex.exe" : "codex")),
    ...(process.platform === "win32" && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe")] : [])
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate); return candidate; } catch { /* next installation */ }
  }
  throw new Error("codex_missing");
}

export class CodexProvider {
  private transport: CodexTransport | null = null;
  private starting: Promise<void> | null = null;
  private loginId: string | null = null;
  private selectedModel: string | null = null;
  private generation = 0;
  private status: CodexStatus = { state: "disconnected", models: [], model: null, limits: [] };
  private readonly home: string;
  private readonly cwd: string;
  constructor(userData: string, private executable?: string) {
    this.home = path.join(userData, "codex-writing");
    this.cwd = path.join(this.home, "empty-workspace");
  }
  setModel(id: string) {
    if (!this.status.models.some(model => model.id === id)) throw new Error("Unknown Codex model");
    this.selectedModel = id; this.status.model = id;
  }
  restoreModel(id: string) { this.selectedModel = id; }
  setExecutable(executable: string) { this.dispose(); this.executable = executable; }
  private async start() {
    if (this.starting) return this.starting;
    if (this.transport) return;
    this.starting = this.boot().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async boot() {
    const generation = this.generation;
    let executable: string;
    try { executable = await resolveCodexExecutable(this.executable); }
    catch { this.status.state = "missing"; throw codexError(); }
    const version = await exec(executable, ["--version"], { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: "" }));
    // Fail closed across protocol/permission changes until explicitly validated.
    if (!/^codex-cli (?:0\.154\.\d+|0\.156\.1)\s*$/u.test(version.stdout.trim())) {
      this.status.state = "incompatible"; throw codexError();
    }
    await mkdir(this.cwd, { recursive: true });
    if (generation !== this.generation) throw codexError();
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.home };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|ELECTRON_RUN_AS_NODE|CODEX_(?!HOME)/i.test(key)) delete env[key as keyof typeof env];
    const args = ["app-server", "--stdio", "--strict-config", ...Object.entries(writingConfig).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];
    const transport = new CodexTransport(executable, args, { cwd: this.cwd, env });
    this.transport = transport;
    transport.on("closed", () => { if (this.transport === transport) { this.transport = null; this.status.state = "error"; } });
    transport.on("notification", (method, params) => {
      if (method === "account/login/completed" && params.loginId === this.loginId) {
        this.loginId = null; this.status.state = params.success ? "connected" : "disconnected";
      }
    });
    try {
      await transport.request("initialize", { clientInfo: { name: "iliad_writing", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      transport.notify("initialized");
      const { config } = await transport.request("config/read", { includeLayers: false });
      for (const [key, value] of Object.entries(writingConfig)) {
        // 0.154's typed config/read omits this UI-only tool toggle.
        if (key === "tools.update_plan.enabled") continue;
        const actual = key.split(".").reduce((object: any, segment) => object?.[segment.replaceAll('"', "")], config);
        if (JSON.stringify(actual) !== JSON.stringify(value)) throw codexError();
      }
    } catch { this.dispose(); this.status.state = "incompatible"; throw codexError(); }
  }
  async getStatus(): Promise<CodexStatus> {
    try {
      await this.start();
      const { account } = await this.transport!.request("account/read");
      if (account?.type !== "chatgpt") {
        this.status.state = this.loginId ? "connecting" : "disconnected";
        this.status.models = []; this.status.limits = []; this.status.model = null;
        return { ...this.status };
      }
      this.status.state = "connected";
      const models: CodexStatus["models"] = [];
      let cursor: string | null = null;
      do {
        const page = await this.transport!.request("model/list", { limit: 100, cursor, includeHidden: false });
        for (const m of page.data) models.push({ id: m.id, name: m.displayName, effort: m.defaultReasoningEffort, isDefault: m.isDefault });
        cursor = page.nextCursor;
      } while (cursor);
      this.status.models = models;
      this.status.model = models.find(m => m.id === this.selectedModel)?.id ?? models.find(m => m.isDefault)?.id ?? models[0]?.id ?? null;
      const limits = await this.transport!.request("account/rateLimits/read").catch(() => null);
      const bucket = limits?.rateLimits;
      this.status.limits = [bucket?.primary, bucket?.secondary].filter(Boolean).map(l => ({ remaining: Math.max(0, 100 - l.usedPercent), resetsAt: l.resetsAt ?? null }));
    } catch { if (!["missing", "incompatible"].includes(this.status.state)) this.status.state = "error"; }
    return { ...this.status };
  }
  async login(): Promise<string> {
    await this.start();
    await this.cancelLogin();
    const result = await this.transport!.request("account/login/start", { type: "chatgpt" });
    const url = new URL(result.authUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) throw codexError();
    this.loginId = result.loginId; this.status.state = "connecting";
    return url.href;
  }
  async cancelLogin() {
    if (this.loginId && this.transport) await this.transport.request("account/login/cancel", { loginId: this.loginId });
    this.loginId = null;
  }
  async logout() { await this.cancelLogin(); if (this.transport) await this.transport.request("account/logout"); this.dispose(); this.status.state = "disconnected"; }
  async generate(instructions: string, input: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const status = await this.getStatus();
    signal.throwIfAborted();
    if (status.state !== "connected") throw codexError("invalid_api_key");
    if (status.limits.some(l => l.remaining === 0 && (!l.resetsAt || l.resetsAt * 1000 > Date.now()))) throw codexError("rate_limited");
    const transport = this.transport!;
    const started = await transport.request("thread/start", { model: status.model, cwd: this.cwd, ephemeral: true, permissions: "iliad-writing", runtimeWorkspaceRoots: [this.cwd], environments: [], selectedCapabilityRoots: [], approvalPolicy: "never", config: writingConfig, baseInstructions: "You are a writing assistant. Return only the requested text in the output schema. Do not use tools.", developerInstructions: instructions });
    const threadId = started.thread.id;
    if (started.modelProvider !== "openai" || started.approvalPolicy !== "never" || started.activePermissionProfile?.id !== "iliad-writing" || started.instructionSources?.length) throw codexError();
    let turnId: string | null = null;
    try {
      signal.throwIfAborted();
      return await new Promise<string>((resolve, reject) => {
        let text = "";
        let settled = false;
        const finish = (error?: Error, value?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); signal.removeEventListener("abort", abort);
          transport.off("notification", notification); transport.off("closed", closed); transport.off("unsafeRequest", unsafe);
          if (error) reject(error); else resolve(value!);
        };
        const interrupt = () => { if (turnId) void transport.request("turn/interrupt", { threadId, turnId }).catch(() => {}); };
        const abort = () => { interrupt(); finish(new DOMException("Canceled", "AbortError")); };
        const closed = () => finish(codexError());
        const unsafe = () => { interrupt(); finish(codexError()); };
        const timer = setTimeout(() => { interrupt(); finish(codexError("request_timeout")); }, CODEX_TIMEOUT_MS);
        const notification = (method: string, params: any) => {
          if (params?.threadId !== threadId) return;
          if (method === "turn/started") turnId = params.turn.id;
          if (method === "item/started" && !["userMessage", "agentMessage", "reasoning"].includes(params.item.type)) { unsafe(); return; }
          if (method === "item/completed" && params.item.type === "agentMessage" && params.item.phase !== "commentary") text = params.item.text;
          if (method === "turn/completed") {
            if (params.turn.status !== "completed") { const code = JSON.stringify(params.turn.error?.codexErrorInfo ?? ""); finish(codexError(/rate|usageLimit/i.test(code) ? "rate_limited" : /unauthorized/i.test(code) ? "invalid_api_key" : "provider_unavailable")); return; }
            try { const output = JSON.parse(text); if (typeof output.text !== "string" || !output.text.trim() || output.text.length > 32000) throw new Error(); finish(undefined, output.text); }
            catch { finish(codexError("malformed_provider_response")); }
          }
        };
        transport.on("notification", notification); transport.on("closed", closed); transport.on("unsafeRequest", unsafe);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        void transport.request("turn/start", { threadId, input: [{ type: "text", text: input }], model: status.model, effort: status.models.find(m => m.id === status.model)?.effort, permissions: "iliad-writing", runtimeWorkspaceRoots: [this.cwd], environments: [], outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }).then(result => { turnId = result.turn.id; if (signal.aborted) interrupt(); }, () => finish(codexError()));
      });
    } finally { void transport.request("thread/unsubscribe", { threadId }).catch(() => {}); }
  }
  dispose() { this.generation++; const transport = this.transport; this.transport = null; transport?.stop(); this.loginId = null; }
}
