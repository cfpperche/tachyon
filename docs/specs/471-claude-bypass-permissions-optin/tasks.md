# 471 — claude-bypass-permissions-optin — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add the optional `authorize` list to `agentNativeConfigPolicySchemaV1` — bounded, identifier
      members, no duplicates. Existing profiles must parse unchanged.
- [x] Add `CLAUDE_PERMISSION_AUTHORIZATIONS` (today: `bypassPermissions`) and a helper that reads a
      family's authorizations from a profile.
- [x] Reject illegal `authorize` in `resolveAgentNativeConfigSupport`: non-Claude adapter, any family
      other than `permissions`, or an unknown member — each with an error naming the declaration.
- [x] Thread the authorization into `projectClaudeNativeConfig` → `permissionsRejection`: accept
      `bypassPermissions` only when authorized; keep the exact `t-111190` diagnosis otherwise, with
      the authorization added as a second remedy in the way-out copy.
- [x] Add the authorization read/write helpers to `agent-studio-shell/domain.ts` and make sure
      `normalizedNativeConfig` preserves it through its per-adapter rebuild on save.
- [x] Add the translated label + risk copy to `createAgentProfileLabels`, and render the checkbox in
      `App.tsx` under the Permissions row — Claude only, hidden when the family is excluded.
- [x] Add both strings to `l10n/bundle.l10n.json` and `l10n/bundle.l10n.pt-br.json` (confirm first
      how neighbouring Agent Studio strings reach the bundle; record the finding in `notes.md`).
- [x] Record the amended contract in `docs/runtimes/parity.md` (Claude row + changelog).
- [x] Add `scripts/dogfood/claude-bypass-optin.ts` and its `dogfood:claude-bypass-optin` npm script.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unauthorized global `bypassPermissions` is still refused with the subkey/value/way-out
      diagnosis, and nothing is projected. (spec: scenario 1)
- [x] Authorized profile projects `permissions.defaultMode: bypassPermissions`. (spec: scenario 2)
- [x] Fresh, restart, resume and fork each materialize the authorized value into the private
      `CLAUDE_CONFIG_DIR`. (spec: scenario 3)
- [x] Two agents on one global file: only the authorized one projects. (spec: scenario 4)
- [x] Agent Studio round-trip preserves the authorization across save + reload. (spec: scenario 5)
- [x] `authorize` on Codex, on a non-permissions family, or with an unknown member is rejected.
- [x] Other refused values, opaque unselected global keys and workspace fail-closed are unchanged.
- [x] Codex confirmed to have no equivalent creation blocker; real gap filed as `t-b0440a`.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- claude-bypass-optin`

**Human dogfood:** open Agent Studio on a canonical Claude agent, set Permissions to *Use global
defaults*, confirm the authorization checkbox appears with its risk copy and is off; enable it, save,
reload, confirm it persisted; switch Permissions to *Exclude* and confirm the checkbox disappears;
open a canonical Codex agent and confirm it is absent there.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

Evidence: `docs/specs/471-claude-bypass-permissions-optin/evidence/authorization-control.png`
(authorized state), `evidence/authorization-control-off.png` (default/off state),
`evidence/agent-studio-claude-bypass-on.png` and `evidence/agent-studio-claude-bypass-off.png` (the
control in the full Agent Studio form), `evidence/agent-studio-codex-absent.png` (Codex — control
correctly absent). Captured from the real Agent Studio shell via the webview preview harness
(`?view=cockpit&fixture=studio-agent-claude-bypass-on&height=2550`).

Verdict: **Two real defects found and fixed by looking.** (1) The risk copy rendered as ordinary
neutral hint text because it used `var(--vscode-testing-iconFailed, var(--ds-danger))` and
`--ds-danger` is not a defined token anywhere — the fallback was dead, so a dangerous authorization
read like a normal help line. Fixed to fall back to `--ds-err`, which exists; the copy now renders
in the error colour with a bold label and a separating rule. (2) The read-only policy preview above
the editor claimed "No native configuration policy is authored for this agent" while the editor
showed one, because the new fixtures did not populate `provenance.nativeConfig`; fixed in the
fixture. After the fixes: control present and unchecked by default for Claude, checked in the
authorized fixture, absent for Codex, and the section's grid alignment is unchanged.

## Cookbook

**Cookbook-Opt-Out:** no new operator/agent surface — one Agent Studio checkbox and a profile field,
both covered by `spec.md` and the human dogfood walkthrough above.
