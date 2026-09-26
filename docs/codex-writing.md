# Codex writing actions

Iliad can use a ChatGPT-authenticated Codex account for **manual** selection
rewrites and sentence, paragraph and idea continuations. Results use the same
Accept/Reject and Tab/Escape review surfaces as Gemini. No chat panel, persistent
conversation or autonomous document editing is added.

## Connect

1. Install Codex CLI separately. This adapter currently accepts **0.154.x**;
   other versions fail closed until their protocol and permission behavior have
   been validated. Iliad does not download or update Codex.
2. Open Writing assists and select Codex. If discovery fails, select its native
   executable. Windows `.cmd` wrappers are not executed through a shell.
3. Choose Connect with ChatGPT and finish signing in in your browser.
4. Select text and use an AI action, or request a continuation with the existing
   shortcuts. Accept the suggestion explicitly to change the document.

The model list and default effort come from the account's model catalog. Usage
consumes the signed-in ChatGPT plan, subject to its limits. API-key sessions are
not accepted; there is no silent Gemini fallback. Signing out here does not sign
out the Codex desktop app or the user's normal CLI profile.

Automatic suggestions are disabled for Codex in both renderer and main. Gemini's
key and automatic-suggestion preference are preserved when switching providers.
The local corrector remains independent of both providers.

## Runtime boundaries

The main process owns a private stdio App Server child with a dedicated
`<Iliad userData>/codex-writing` home. Codex manages authentication there; no
credentials are copied from the user's normal Codex profile or returned through
renderer IPC. Login uses the official browser flow and its temporary callback.

Each action starts an ephemeral thread with only the existing bounded writing
context and instructions. Its working directory is an isolated empty folder,
not the user's workspace. The adapter disables shell, code execution, browser,
computer use, apps, subagents, remote plugins and discovery features; checks the
effective configuration; requires a read-only thread without inherited
instruction files; and selects a named permission profile restricted to platform minimum reads and the isolated workspace. The 0.154 protocol requires its experimental permission-profile fields; legacy `readOnly.access` is rejected. Unexpected
client tool/approval requests and tool items fail the action. The adapter never
offers tools implemented by Iliad and never grants filesystem write access.

The permission/configuration contract is deliberately version bounded. Do not
widen the supported version range based on a successful handshake alone. Check
effective restrictions, tool availability and isolation on the candidate version.

Responses must complete successfully and contain a nonempty structured `text`
field. Existing stale-selection checks and output cleaners remain in force.
Actions can be canceled, time out after 90 seconds, and are not automatically
resubmitted by Iliad. One renderer's new writing request cancels its previous
selection or continuation request; other windows remain independent.

## Validation

Run `npm run typecheck`, `npm test`, `npm run lint:css`, and `npm run build`.
The Codex adapter and transport tests use simulated responses without credentials.
Windows packaging and installed-app regression follow `windows-validation.md`.

Before marking a release validated, use a synthetic document and a separate test
profile to connect a real account, exercise Spanish and English actions,
accept/reject, cancellation, restart and logout isolation. Record actual results
separately from simulated tests. Never put account details, login URLs, profiles,
document content or authentication tokens into reports or Git.

Protocol reference: https://learn.chatgpt.com/docs/app-server
