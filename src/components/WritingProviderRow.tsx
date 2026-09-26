import { useState } from "react";
import type { AppStrings } from "../i18n/strings";
import type { WritingAssistStatus, IliadApi } from "../types/iliad";

export function WritingProviderRow({ status, labels, refresh }: {
  status: WritingAssistStatus | null;
  labels: AppStrings["writingAssists"];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setFailed(false);
    try { await operation(); } catch { setFailed(true); }
    finally { await refresh(); setBusy(false); }
  };
  const action = (name: Parameters<IliadApi["codexAction"]>[0], value?: string) => void run(() => window.iliad.codexAction(name, value));
  const codex = status?.codex;
  return <div className="writing-assist-key writing-provider">
    <label className="writing-assist-shortcut-row">{labels.provider}
      <select aria-label={labels.provider} disabled={busy} value={status?.selectedProvider ?? "gemini"}
        onChange={event => void run(() => window.iliad.setWritingProvider(event.target.value as "gemini" | "codex"))}>
        <option value="gemini">Gemini</option><option value="codex">Codex</option>
      </select>
    </label>
    {status?.selectedProvider === "codex" && <>
      <span className="writing-assist-switch-note">{labels.codexManual}</span>
      <span role="status">{labels.codexStates[codex?.state ?? "disconnected"]}</span>
      {codex?.state === "connected" ? <>
        <label className="writing-assist-shortcut-row">{labels.codexModel}
          <select aria-label={labels.codexModel} value={codex.model ?? ""} disabled={busy} onChange={event => action("model", event.target.value)}>
            {codex.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        {codex.limits.map((limit, index) => <span className="writing-assist-switch-note" key={index}>
          {labels.codexRemaining(limit.remaining)}{limit.resetsAt ? ` · ${new Date(limit.resetsAt * 1000).toLocaleString()}` : ""}
        </span>)}
        <button type="button" className="writing-assist-link" disabled={busy} onClick={() => action("disconnect")}>{labels.codexDisconnect}</button>
      </> : <button type="button" className="writing-assist-link" disabled={busy} onClick={() => action(codex?.state === "connecting" ? "cancel" : "connect")}>
        {codex?.state === "connecting" ? labels.codexCancel : labels.codexConnect}
      </button>}
      <button type="button" className="writing-assist-link" disabled={busy} onClick={() => action("executable")}>{labels.codexExecutable}</button>
    </>}
    {failed && <span role="alert" className="writing-assist-key-error">{labels.codexFailed}</span>}
  </div>;
}
