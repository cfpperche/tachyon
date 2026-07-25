# 450 — remove-legacy-agent-format — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Canonical lifecycle journals moved to `.tachyon/canonical-agent-transactions/`. Reusing
  `.tachyon/agent-profile-transactions/` would collide with the independent Soul transaction format.
- The daemon Doctor now validates through `Workspace.parseTrustedConfigText`; its old direct
  `loadConfigFile` call falsely diagnosed canonical pointers as missing `cmd`.
- `Workspace.createForTest` retains an explicit fixture-only compatibility switch so unrelated legacy
  unit fixtures can be converted incrementally. Production construction never enables it.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The installed `.tachyon/agent-profile-migrations/` root contained seven exact rolled-back journals,
  including `22609f0b-885a-48a2-a429-18544d1b3669`; the root was removed after verifying every
  top-level journal was `rolled-back`. Canonical and Soul transaction roots were not touched.
- The adversarial Claude Opus review was attempted three times. The first two runs correctly refused
  because the probe sandbox could not read the worktree; the evidence-embedded run is recorded as
  `probe-4b4a2597-c060-4ca5-a86e-766d2b09b521`.
- The evidence-embedded review found transaction-helper hardening opportunities. Release closures are
  now idempotent, partial multi-lock acquisition drains every acquired lock, lock order is
  locale-independent, commit-time file checks reopen with no-follow semantics, and successful rename
  never runs temporary-path cleanup. Its stale-lock blocker was rejected: recovery deliberately uses
  the persisted journal txid, not a new txid. Its inline-agent blocker conflicts with this spec's
  explicit fail-closed acceptance criterion, and its command-registration concern was disproved by the
  repository-wide grep.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Generic YAML helpers remain because terminals still use them. Production callers now constrain them
  to declared terminals or canonical profile operations; removal of the helpers would break supported
  terminal editing without improving the agent authority boundary.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
