# 471 — claude-bypass-permissions-optin — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

The projector currently decides whether `permissions.defaultMode` is projectable by looking only at
the value. The whole change is to make that decision depend on the **profile** as well: the source
file supplies a value, the profile authorizes it, and both must agree before a dangerous mode is
projected.

Concretely, the permissions policy in a canonical profile gains an optional `authorize` list. It is
an allowlist of otherwise-refused values this specific agent is permitted to project. Today exactly
one member is legal — `bypassPermissions` — and anything else is a validation error, so the
fail-closed posture is preserved by construction rather than by convention.

`projectClaudeNativeConfig` then threads that authorization into `permissionsRejection`: an
unauthorized `bypassPermissions` produces exactly today's diagnosis (subkey, value, supported set,
way out), while an authorized one is accepted and copied into the projected settings like any other
measured value. Nothing else about the allowlist, the workspace fail-closed rule, or the opaque
treatment of unselected global keys moves.

Lifecycle needs no new machinery: the authorized value rides inside `projection.settings`, which the
harness already regenerates into the private `CLAUDE_CONFIG_DIR` on fresh/restart/resume and copies
into a distinct private home on fork. The work there is proving it, not building it.

Agent Studio gains a checkbox under the Permissions row, rendered only for Claude and only when the
family is not excluded, wired through the same `nativeConfig` field the dropdown already edits so
save/round-trip come for free. Its label and risk copy go through the injected translate function
and into both l10n bundles.

## Key decisions

- **Authorization lives on the permissions policy as `authorize: [bypassPermissions]`** — chosen
  because the authorization is an attribute of *how that family is projected*, so it sits next to
  `source`/`treatment`/`lifecycle` where a reviewer reading the profile already looks, and it
  round-trips through the existing Agent Studio `nativeConfig` plumbing with no new persistence
  path. Rejected a separate top-level `dangerousPermissions:` block because it splits one decision
  across two places in the profile and would need its own read/write/round-trip path; rejected
  reusing `treatment` (e.g. a `bypass` treatment) because treatment describes projection mechanics
  for every family and runtime, and overloading it would leak a Claude permission concept into
  Codex's policy vocabulary.
- **`authorize` is a list, not a boolean** — chosen because the shape generalizes to a future second
  dangerous value without another schema change, and because a named member is self-documenting in
  the profile (`authorize: [bypassPermissions]` reads as consent to a specific thing). Rejected
  `allowBypassPermissions: true` because a boolean named after one value would have to be replaced,
  not extended.
- **Validation is layered: schema shape, then per-runtime legality** — the schema accepts an
  optional bounded list of identifiers; `resolveAgentNativeConfigSupport` (already the per-runtime
  policy gate) rejects `authorize` on a non-Claude adapter, on any family other than permissions, or
  naming an unknown member. Chosen so a Codex profile cannot quietly carry a Claude authorization,
  and so the error names the offending declaration. Rejected validating only inside the Claude
  projector, because a Codex profile declaring `authorize` would then pass validation silently.
- **Additive optional field, no migration** — every existing profile parses unchanged and defaults
  to unauthorized. Old Tachyon versions reading a new profile would reject the unknown key under
  `.strict()`, which is the safe direction for a security field: an older build refuses rather than
  ignores.
- **The refusal message is reused verbatim when unauthorized** — chosen so `t-111190`'s diagnosis
  work is not duplicated or forked; the way-out copy gains the authorization as an additional
  remedy rather than a replacement.

## Files touched

- `src/config/agentNativeConfigSchema.ts` — optional `authorize` list on the policy schema.
- `src/config/agentNativeConfigPolicy.ts` — per-runtime legality in
  `resolveAgentNativeConfigSupport`; helper for reading a family's authorizations.
- `src/config/claudeNativeConfigProjection.ts` — thread authorization into the permissions
  rejection; accept the authorized value.
- `src/webview/agent-studio-shell/domain.ts` — labels (translated), field read/write helper for the
  authorization, serialization into the saved `nativeConfig`.
- `src/webview/agent-studio-shell/App.tsx` — the checkbox + risk copy under the Permissions row.
- `l10n/bundle.l10n.json`, `l10n/bundle.l10n.pt-br.json` — the new strings.
- `docs/runtimes/parity.md` — record the authorization in the Claude row + changelog.
- Tests: `test/unit/agentProfileConfigLoader.test.ts` (projection + per-agent isolation),
  `test/unit/agentNativeConfigPolicy.test.ts` (legality), `test/unit/agentProfileStudio.test.ts`
  (round-trip), `test/unit/harnessCanonicalClaude*` / lifecycle coverage (fresh/restart/resume/fork).
- `scripts/dogfood/claude-bypass-optin.ts` + a `dogfood:` npm script — headless end-to-end.

## Risks & unknowns

- **The security-critical risk is a false positive**: authorizing when the profile did not ask. The
  mitigation is that authorization is read from the parsed profile only, defaults to absent, and the
  per-agent isolation scenario in `spec.md` is an explicit test with two agents sharing one global
  file.
- Fork copies the projection into a *distinct* private home; the fork path must carry the authorized
  value without re-reading the global file. Verify against the existing fork coverage rather than
  assuming.
- Agent Studio's canonical form derives `nativeConfig` at serialize time from the family dropdown
  (`normalizedNativeConfig`), which rebuilds the policy object per adapter — the authorization must
  be preserved through that rebuild or it will silently reset on every save. This is the most likely
  place to get it wrong; cover it with a round-trip test.
- The l10n bundles do not currently contain the neighbouring Agent Studio strings, so the harvest
  path may be partial; confirm how existing webview strings reach the bundle before assuming a new
  entry is required, and record what was found.

## Visual impact

Agent Studio's canonical **Native configuration** section gains a checkbox and a risk hint beneath
the Permissions row. Ways it could look wrong: the checkbox appearing for Codex agents, appearing
when Permissions is set to Exclude, the risk copy being visually indistinguishable from the neutral
`hint` text used elsewhere in the section, or the row's grid alignment breaking because the existing
`ash-native-config-editor-row` is a label+control pair. Proof will be a rendered screenshot of the
section for an authorized Claude agent, an unauthorized one, and a Codex agent (control absent),
captured from the webview preview and recorded under `## Visual QA`.

## Sources consulted

- `src/config/claudeNativeConfigProjection.ts` — `CLAUDE_PERMISSION_MODES`, `permissionsRejection`,
  the `t-111190` diagnosis, and the `t-45e80d` global/workspace asymmetry.
- `src/config/codexNativeConfigProjection.ts:24,31,319-320` — Codex accepts `approval_policy` and
  `sandbox_mode` as *any* string, so it has no equivalent refusal and therefore no equivalent
  creation blocker. This confirms the coordinator's conclusion, and also shows the asymmetry runs
  the other way: dangerous Codex values are inherited from global with no authorization at all.
  Filed separately, not addressed here.
- `src/config/agentNativeConfigSchema.ts`, `agentNativeConfigPolicy.ts` — policy shape, the
  `.strict()` boundary, and `resolveAgentNativeConfigSupport` as the per-runtime gate.
- `src/webview/agent-studio-shell/domain.ts:622-660,743-835`, `App.tsx:1170-1195` — the labels
  factory, `nativeConfigChoice`/`setNativeConfigChoice`, and `normalizedNativeConfig`'s per-adapter
  rebuild.
- `docs/specs/460-claude-native-config-inheritance/spec.md`, `docs/runtimes/parity.md:174,222` — the
  standing contract that `bypassPermissions` is rejected by the canonical projector, which this spec
  amends to "rejected unless explicitly authorized per agent".
- `docs/specs/465-claude-native-policy-parity/plan.md` — prior art for the family/source model.
