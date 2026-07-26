# 472 — codex-danger-value-optin — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Measurement (done first — it changed the design)

Measured against **`codex-cli 0.145.0`** on this machine, with an isolated `CODEX_HOME`, by feeding
an invalid value and reading the parser's own "expected one of" list, then loading every candidate:

| key | accepted as a scalar | notes |
|---|---|---|
| `approval_policy` | `untrusted`, `on-failure`, `on-request`, `never` | parser also lists `granular`, but it is a **newtype variant** (`invalid type: unit variant, expected newtype variant`) — a TOML table, never a scalar string |
| `sandbox_mode` | `read-only`, `workspace-write`, `danger-full-access` | all three load cleanly |

This is why the task required measuring. The **CLI flag** enums are *narrower* than the config ones:
`--ask-for-approval` offers only `untrusted`, `on-request`, `never`. Had the enum been copied from
`codex --help`, `on-failure` would have been wrongly refused for every existing user who has it.

Dangerous, i.e. requiring authorization: **`approval_policy = "never"`** (never asks) and
**`sandbox_mode = "danger-full-access"`** (no sandbox; the CLI names the danger itself). The rest are
bounded by either a prompt or a sandbox and stay freely projectable.

## Approach

Reuse SDD 471's mechanism rather than inventing a parallel one. `authorize` already exists on the
shared native-config policy schema and is already validated per runtime in
`resolveAgentNativeConfigSupport`; that gate currently hard-codes "Claude permissions only". Widen it
to a small per-runtime table of legal authorization members, so Claude keeps
`bypassPermissions` and Codex gains `neverAskForApproval` and `dangerFullAccess` — and neither
runtime can declare the other's.

In the projector, `typedValue` stays the type check; a new value check runs after it for the two
permission keys: reject anything outside the measured enum as unsupported, and reject a dangerous
member unless this profile authorized it. The refusal text follows the shape `t-111190` established
for Claude — key, value, supported set, and the ways out — so the two runtimes read the same.

Agent Studio gets two checkboxes under the Codex Permissions row, mirroring the Claude one: rendered
only for Codex, only while the family is projected, off by default, carried through
`normalizedNativeConfig`'s per-adapter rebuild, and localized in both bundles.

Lifecycle needs no new machinery — the authorized value rides in `projection.permissions` which the
harness already regenerates into the private `CODEX_HOME` on fresh/restart/resume. Codex has no
fork, per the parity doc, so the phase set is the Codex triple, not Claude's four.

## Key decisions

- **Widen the existing `authorize` gate into a per-runtime table** — chosen so one concept covers
  both runtimes and the Claude rule stays enforced by the same code path. Rejected adding a separate
  Codex-only field, which would have duplicated the schema, the studio round-trip and the tests for
  a mechanism that already exists.
- **Authorization members are named for the danger, not the key** (`neverAskForApproval`,
  `dangerFullAccess`) — chosen because the member reads as consent to a specific capability in the
  profile, and because one key could later have two dangerous values. Rejected `approvalPolicy` /
  `sandboxMode` (naming the key would authorize *any* future dangerous value of that key, which is
  exactly the silent widening this spec exists to prevent).
- **Validate the whole measured enum, not only the dangerous values** — an unrecognized value is now
  refused as unsupported instead of projected blindly. This is the part that makes Codex actually
  fail-closed; the authorization is only the escape hatch on top.
- **`granular` is out of scope, explicitly** — measured as a non-scalar, and `typedValue` already
  rejects a table as "must be string". Recording it prevents a future reader from "fixing" the enum
  by adding it.

## Files touched

- `src/config/agentNativeConfigPolicy.ts` — per-runtime authorization table + Codex members.
- `src/config/codexNativeConfigProjection.ts` — measured enums, value validation, authorization.
- `src/webview/agent-studio-shell/domain.ts`, `App.tsx` — the two Codex checkboxes + labels.
- `l10n/bundle.l10n.json`, `l10n/bundle.l10n.pt-br.json` — new strings.
- `docs/runtimes/parity.md` — Codex permission-inject row + changelog.
- Tests: `codexNativeConfigProjection.test.ts`, `agentNativeConfigPolicy.test.ts`,
  `agentProfileConfigLoader.test.ts`, `agentStudioAdapter.test.ts`, `harness.test.ts`.
- `scripts/dogfood/codex-danger-optin.ts` + npm script.

## Risks & unknowns

- **Regression risk on existing profiles is the real one.** Today any string projects; after this,
  an unmeasured value fails activation. That is the intended fail-closed posture, but it means a
  config using a value this enum does not know would break an agent that works today. Mitigated by
  measuring the full enum from the parser rather than from `--help`, and by covering every measured
  value with a test.
- The measurement is version-bound (0.145.0). Recorded in the spec, the parity doc and the code so a
  future CLI change is a known re-measurement, not a mystery.
- Claude's rule must not regress while the gate is generalized — covered by keeping the existing
  Claude legality assertions green and adding cross-runtime refusals.

## Visual impact

The Codex Permissions row gains two checkboxes with risk copy, in the same block the Claude
authorization uses. Ways it could look wrong: appearing for Claude, appearing when Permissions is
excluded, the two risk lines crowding each other, or the copy not reading as a warning. Proof will
be preview screenshots of a canonical Codex agent in both states, plus the Claude fixture confirming
its own control is unchanged.

## Sources consulted

- Live measurement against `codex-cli 0.145.0` (transcript above).
- `src/config/codexNativeConfigProjection.ts:23-27,272-292,294-350` — family keys, `typedValue`,
  the workspace-only allowlist scan.
- `src/config/agentNativeConfigPolicy.ts` — `authorize`, `nativeConfigAuthorizations`, and the
  per-runtime gate shipped by SDD 471 / `t-98427e`.
- `docs/specs/471-claude-bypass-permissions-optin/` — the mechanism and message shape being reused.
- `docs/runtimes/parity.md:175,222` — the Codex row and the Claude permission-inject contract.
