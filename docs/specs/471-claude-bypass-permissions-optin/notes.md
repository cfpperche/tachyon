# 471 — claude-bypass-permissions-optin — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **`authorize` is read from the profile, never from the source file.** `projectClaudeNativeConfig`
  resolves the authorization set once, up front, from `profile.nativeConfig.permissions.authorize`.
  Nothing in the projector consults the settings file to decide what is *allowed* — that separation
  is the whole security property, so it is stated explicitly in the code rather than left implicit.
- **The way-out copy is conditional.** A refused `defaultMode` mentions the authorization route only
  when the offending value is actually authorizable. A typo'd mode still gets the plain
  Exclude/change-the-value remedy, so the message never advertises an authorization that would not
  help.
- **Excluding the Permissions family drops the authorization.** `normalizedNativeConfig` skips
  excluded families entirely, so the authorization disappears with the policy it belongs to — the
  correct reading of "stop projecting permissions". Covered by a test.

## Findings

- **Confirmed the Codex question the task asked.** Codex has no equivalent creation blocker:
  `codexNativeConfigProjection.ts:319-320` reads `approval_policy`/`sandbox_mode` through
  `typedValue(..., "string", ...)`, which only checks the type, and the allowlist scan is
  workspace-only. The coordinator's conclusion is correct. **But the reason there is no blocker is
  itself a gap**: Codex validates no value at all, so `approval_policy = "never"` and
  `sandbox_mode = "danger-full-access"` are inherited from a person's global config with no
  authorization whatsoever. Filed as **`t-b0440a`**; deliberately not implemented here.
- **Localization reach confirmed before assuming.** `createAgentProfileLabels` is called with
  `vscode.l10n.t` from `src/cockpit/studioRegistry.ts:119`, so these are real VS Code UI strings and
  both bundles needed entries. Noted in passing: several neighbouring Agent Studio strings (e.g.
  `"Native configuration"`) are **not** in `l10n/bundle.l10n.json` — a pre-existing gap, left alone.
- **`--ds-danger` is a dead CSS token.** Caught by visual QA, not by tests. The design system defines
  `--ds-err` (`design-system.css:46`); `--ds-danger` is defined nowhere, so
  `var(--vscode-testing-iconFailed, var(--ds-danger))` silently degrades to inherited body text
  wherever the VS Code token is absent — which made the risk copy read as an ordinary neutral hint.
  Fixed for the new rule by falling back to `--ds-err`. The adjacent pre-existing
  `.ash-native-config-unsupported` has the same dead fallback but renders correctly in real VS Code
  (where `--vscode-testing-iconFailed` exists) and degrades only in the preview harness, so it was
  left as-is rather than widened into this change.

## Deviations

- The plan expected the round-trip coverage in `test/unit/agentProfileStudio.test.ts`. The studio
  form helpers are actually exercised in `test/unit/agentStudioAdapter.test.ts` (which imports
  `canonicalAgentFields`/`serializeAgentPatch` directly), so it went there instead.
- **The preview harness could not show the surface at all.** `#frame` is `overflow: hidden` at a
  fixed per-route height, so a form taller than the frame is clipped with no scrollbar and is
  unreachable — scrolling any inner container does nothing. Added a `?height=` override symmetric
  with the existing `?width=`; that is what made this section inspectable.
- Two preview fixtures plus a `provenance.nativeConfig` preview payload were added so the control
  renders in both states. Without them the only canonical fixture is Codex, where the control is
  correctly absent — i.e. there was nothing to look at.

## Tradeoffs

- `authorize` lives on the shared policy schema (all families, all runtimes) rather than on a
  Claude-only type, which means an illegal placement is caught by per-runtime validation instead of
  by the type system. Accepted because the alternative — a parallel Claude-specific policy shape —
  would fork the schema and the Agent Studio round-trip path for one field.

## Open questions

None. The `authorize` storage shape was settled in `plan.md` with the rejected alternatives recorded.

## Verification log

<!-- appended by `/sdd verify --run` -->

## Dogfood log

<!-- appended by `/sdd dogfood --run` -->

### 2026-07-26T18:49:00Z — pass (1/1) — source: tasks.md — commit: 0c21d35ef5524b0b9318623c6476885e5d0ccf44
- `npm run dogfood -- claude-bypass-optin` — pass
