import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import type { GeminiKeyState } from "../writing/settingsStore.js";
import type { WritingAiService, WritingAssistStatus } from "../writing/writingAiService.js";
import { isTrustedIpcSender, type TrustedIpcEvent } from "./trust.js";

type WritingSettingsService = Pick<WritingAiService, "writingAssistStatus" | "getGeminiKeyState" | "setGeminiApiKey"> & Partial<Pick<WritingAiService, "setProvider" | "codexAction">>;

const MAX_GEMINI_KEY_CHARS = 512;
function notifyWritingSettingsChanged() {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("writing:settings-changed");
}

const untrustedStatus: WritingAssistStatus = {
  corrector: { available: false, provider: null },
  autocomplete: { available: false, provider: null, model: null },
  geminiKey: { hasKey: false, last4: null }
};

export function registerWritingSettingsIpc({ service }: { service: WritingSettingsService }) {
  ipcMain.handle("writing:provider", async (event, provider: unknown) => {
    if (!isTrustedIpcSender(event) || (provider !== "gemini" && provider !== "codex")) throw new Error("Invalid provider");
    await service.setProvider?.(provider);
    notifyWritingSettingsChanged();
  });
  ipcMain.handle("writing:codex", async (event, action: unknown, value: unknown) => {
    if (!isTrustedIpcSender(event) || !["connect", "cancel", "disconnect", "model", "executable"].includes(String(action))) throw new Error("Invalid Codex action");
    if (action === "executable") {
      const result = await dialog.showOpenDialog({ properties: ["openFile"], filters: process.platform === "win32" ? [{ name: "Codex", extensions: ["exe"] }] : [] });
      if (!result.canceled && result.filePaths[0]) await service.codexAction?.("executable", result.filePaths[0]);
    } else {
      if (value !== undefined && (typeof value !== "string" || value.length > 200)) throw new Error("Invalid model");
      const url = await service.codexAction?.(action as "connect" | "cancel" | "disconnect" | "model", value as string | undefined);
      if (action === "connect" && url) await shell.openExternal(url);
    }
    notifyWritingSettingsChanged();
  });
  ipcMain.handle("writing-assist:status", (event) => handleWritingAssistStatusIpc(event, service));
  ipcMain.handle("writing:get-gemini-key-state", (event) => handleGetGeminiKeyStateIpc(event, service));
  ipcMain.handle("writing:set-gemini-key", (event, key: unknown) => handleSetGeminiKeyIpc(event, key, service));
}

export function handleWritingAssistStatusIpc(event: TrustedIpcEvent, service: WritingSettingsService) {
  return isTrustedIpcSender(event) ? service.writingAssistStatus() : untrustedStatus;
}

export function handleGetGeminiKeyStateIpc(
  event: TrustedIpcEvent,
  service: WritingSettingsService
): Promise<GeminiKeyState> | GeminiKeyState {
  return isTrustedIpcSender(event) ? service.getGeminiKeyState() : { hasKey: false, last4: null };
}

export async function handleSetGeminiKeyIpc(
  event: TrustedIpcEvent,
  key: unknown,
  service: WritingSettingsService
): Promise<GeminiKeyState> {
  if (!isTrustedIpcSender(event)) {
    throw new Error("The key request came from an untrusted window.");
  }

  if (key !== null && typeof key !== "string") {
    throw new Error("The Gemini API key must be text.");
  }

  if (typeof key === "string" && (key.trim().length > MAX_GEMINI_KEY_CHARS || /\s/.test(key.trim()))) {
    throw new Error("That does not look like a Gemini API key.");
  }

  return service.setGeminiApiKey(key);
}
