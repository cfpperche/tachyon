# 472 — codex-danger-value-optin — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **Measurement came before the enum, and it changed the answer.** The CLI flag help
  (`--ask-for-approval`) lists only `untrusted`, `on-request`, `never`. The **config** parser accepts
  `untrusted`, `on-failure`, `on-request`, `granular`, `never`. Copying the flag list — the obvious
  shortcut — would have refused `on-failure` for every user who already has it, breaking working
  agents in the name of security. The task's insistence on measuring is what caught this.
- **`granular` is a real variant but not a scalar.** It fails to load as a bare string with
  `invalid type: unit variant, expected newtype variant`, i.e. it is a TOML table. `typedValue`
  already rejects a table as "must be string", so it needs no special case — but it IS recorded as a
  non-goal so a future reader does not "fix" the enum by adding it.
- **Members are named for the capability, not the key.** `neverAskForApproval` / `dangerFullAccess`
  rather than `approvalPolicy` / `sandboxMode`. Naming the key would silently authorize any future
  dangerous value of that key, which is the exact widening this mechanism exists to prevent.
- **Validate the whole enum, not just the dangerous values.** The authorization is the escape hatch;
  the enum is what actually makes Codex fail-closed. Before this, any string projected.

## Deviations

- The plan said "reuse the `authorize` gate"; in practice the gate had to be **generalized**, not
  merely reused — it hard-coded "Claude permissions only", including in its error text. It is now a
  per-runtime table, so the refusal runs both ways (a Claude profile cannot carry `dangerFullAccess`
  either) and a runtime with no declared members still refuses `authorize` outright.
- The Agent Studio helpers were Claude-specific (`nativeConfigBypassAuthorized`,
  `canAuthorizeBypassPermissions`, `setNativeConfigBypassAuthorized`). They became member-generic
  (`nativeConfigAuthorized`, `permissionAuthorizationChoices`, `setNativeConfigAuthorized`), and the
  SDD 471 tests were migrated to the new API rather than duplicated.

## Tradeoffs

- **This is the one change here that can break a working setup.** An agent whose global config uses
  a value outside the measured enum used to project and now fails activation. That is the intended
  fail-closed posture and the whole point of the task, but it is a real behavior change, not a pure
  addition. Mitigated by measuring the full config enum (not the narrower flag enum) and by covering
  every measured value with a test so the accepted set is explicit rather than incidental.
- One pre-existing test (`projects only the ratified global keys…`) used `never` /
  `danger-full-access` as its sample values. It was testing which *keys* are ratified, not the
  values, so it moved to safe values rather than being weakened — the dangerous path got its own
  dedicated coverage.

## Open questions

None. The measured enums are version-bound to `codex-cli 0.145.0` and recorded in the code, the
spec, the parity doc and the refusal message itself, so a future CLI change surfaces as a known
re-measurement rather than a mystery.

## Verification log

<!-- appended by `/sdd verify --run` -->

## Dogfood log

<!-- appended by `/sdd dogfood --run` -->

### 2026-07-26T19:19:41Z — pass (1/1) — source: tasks.md — commit: 54f7b8ebf58d863b91058a4b313fbeb9b3138614
- `npm run dogfood -- codex-danger-optin` — pass
