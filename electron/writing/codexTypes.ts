export type WritingProvider = "gemini" | "codex";
export interface CodexModel { id: string; name: string; effort: string; isDefault: boolean }
export interface CodexStatus {
  state: "disconnected" | "connecting" | "connected" | "missing" | "incompatible" | "error";
  models: CodexModel[];
  model: string | null;
  limits: Array<{ remaining: number; resetsAt: number | null }>;
}
