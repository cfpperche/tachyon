# 472 — codex-danger-value-optin — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Generalize the `authorize` legality gate in `resolveAgentNativeConfigSupport` into a
      per-runtime table; keep Claude's `bypassPermissions` rule exactly as it is.
- [x] Add the Codex authorization members `neverAskForApproval` and `dangerFullAccess`.
- [x] Add the measured enums to `codexNativeConfigProjection.ts`, recording the CLI version they
      were measured against.
- [x] Validate `approval_policy`/`sandbox_mode` values after the type check: unmeasured value →
      unsupported; dangerous value → refused unless this profile authorizes it. Refusal names key,
      value, supported set and the ways out.
- [x] Add the Codex authorization read/write helpers to the studio domain and carry them through
      `normalizedNativeConfig`'s per-adapter rebuild.
- [x] Render the two checkboxes + risk copy for Codex in `App.tsx`; add translated labels.
- [x] Add the strings to both l10n bundles.
- [x] Record the contract in `docs/runtimes/parity.md` (Codex row + changelog), naming the measured
      CLI version.
- [x] Add `scripts/dogfood/codex-danger-optin.ts` and its npm script.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unauthorized global `approval_policy = never` is refused naming key/value/way-out. (scenario 1)
- [x] Unauthorized global `sandbox_mode = danger-full-access` is refused. (scenario 2)
- [x] An authorized profile projects the dangerous value. (scenario 3)
- [x] Two agents, one global config: only the authorized one projects. (scenario 4)
- [x] Every measured safe value still projects with no authorization. (scenario 5)
- [x] Fresh/restart/resume carry the authorized value into the private `CODEX_HOME`. (scenario 6)
- [x] An unmeasured value is refused as unsupported.
- [x] Codex authorizations refused on Claude / non-permissions family / unknown member, and Claude's
      `bypassPermissions` still refused on Codex.
- [x] Agent Studio round-trip preserves both Codex authorizations; control hidden for Claude and
      when the family is excluded.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:codex-danger-optin`

**Human dogfood:** open Agent Studio on a canonical Codex agent, set Permissions to *Use global
defaults*, confirm both authorization checkboxes appear with risk copy and are off; enable one,
save, reload, confirm it persisted; set Permissions to *Exclude* and confirm they disappear; open a
canonical Claude agent and confirm only its own bypass control is present.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded._

Evidence: `docs/specs/472-codex-danger-value-optin/evidence/agent-studio-codex-danger-on.png`
(both authorizations checked), `evidence/agent-studio-codex-danger-off.png` (default/off), and
`evidence/agent-studio-claude-bypass-on.png` (Claude unchanged, showing only its own control).
Captured from the real Agent Studio shell via the preview harness
(`?view=cockpit&fixture=studio-agent-codex-danger-on&height=2550`).

Verdict: **Correct, no defects found this round.** Both Codex checkboxes render under the
Permissions row with the error-coloured risk copy and their own separating rule, unchecked by
default and checked in the authorized fixture. Runtime isolation verified by extracting the rendered
text: the Codex form shows both Codex controls and zero Claude controls; the Claude form shows only
`Authorize bypassing permission prompts` and neither Codex control. The `--ds-err` fallback fixed in
SDD 471 carries these new lines correctly, so the risk copy reads as a warning rather than a
neutral hint.

## Cookbook

**Cookbook-Opt-Out:** no new operator/agent surface — two Agent Studio checkboxes and profile
authorization members, covered by `spec.md` and the human dogfood walkthrough above.
