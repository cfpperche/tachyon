# 270 — notes

## Why this exists (2026-06-26)

The owner wants **configurable plugins**: the Plugins view should let the human view/edit a plugin's config
(json/yaml/other), the card should carry a **Docs** button to a creator-defined URL, and installing a configurable
plugin should auto-navigate to its config view. The motivating first consumer is the `agent-browser` per-site trust
policy (spec 271) — a human-curated list of trusted sites + events (e.g. `example.com` = full bypass, `x.com` =
readonly). Confirming every browser action is friction the owner explicitly rejects; the answer is **human-authored
policy the agent must respect**, not per-event prompts.

## Governance invariant (owner, stated twice)

The human is the OWNER of actions. The agent never defines or loosens configuration; if the human permits it, it is
permitted; Tachyon RESPECTS the human's config. Today the launcher already enforces this for agent-browser via the
spec-269 `launchPolicy { mode:"force", denyArgs:[…] }` — the agent cannot repoint/loosen the write-gate through
args. Configurable plugins must EXTEND that spine (human config flows through consent/lockfile/launcher) and must
not become a new agent-reachable bypass. This is why 270 deliberately stops at **generic convenience config + the
editing UX**, and leaves the **security-relevant** lane (Tachyon-owned path + launcher enforcement) to 271.

## Codex review (2026-06-26, independent second model — read /home/goat/tachyon)

Reviewed the full design; strong convergence, several tightenings folded:
- **JSON-only validated in v1** (YAML opens in an editor later; equal live schema validation isn't guaranteed).
- **`docsUrl` `https://`-only** — no `command:`/`file:`/extension URIs through `openExternal` (would be an attack
  vector).
- **Post-install auto-open only after a successful apply**, and Config/Docs metadata must be available from
  **installed state** — the card view-model is lockfile-driven (`viewModel.ts:38`), so persist the descriptor +
  docsUrl in the lockfile rather than re-reading the payload.
- **No arbitrary `config.path` for a security policy.** Generic config path can be constrained; a trust policy path
  must be **Tachyon-owned** and the plugin must not inject a runtime-readable policy file (manifest parsing is the
  untrusted marketplace boundary, `manifest.ts:7`). → the **two-lane** separation (A5).
- **Co-develop 270 + 271 as a vertical slice** — don't ship all of 270 in isolation; the agent-browser policy is
  the first real requirement and will expose whether the primitives are sufficient.
- **Biggest risk:** turning "human-owned trust config" into "agent-reachable policy relaxation." The hard part is
  not the editor UI — it's keeping `bypass` a launcher-owned decision while preventing the agent from supplying
  alternate config/env/args that produce the same relaxation outside the human-authored policy. (Mostly 271's
  burden; 270's job is to not open the channel.)

## Sources

- codex review transcript (cwd /home/goat/tachyon): positions + tightenings above; cited `lockfile.ts:115`,
  `toolLauncher.ts:231`, `manifest.ts:7`, `viewModel.ts:38`.
- `src/plugins/manifest.ts:112-130` (`PluginManifest` — no config/docsUrl today), `src/plugins/viewModel.ts:38-52`
  (`InstalledPluginVM`, lockfile-driven), `src/webview/PluginsPanel.ts` (webview install, no post-apply nav),
  `docs/specs/250-*` (plugin system), `docs/specs/269-*` (launch policy spine 271 extends).
