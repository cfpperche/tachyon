# 509 — persistent-instructions-launch — notes

_Created 2026-08-15._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- The launch layer is gated by canonical profile provenance (`profileLifecycle` or `profileFork`), not merely by a populated `AgentEntry.instructions`, so Temporary task/role text does not silently become durable developer policy.
- The startup brief continues to carry the profile section for compatibility. Compact survival no longer relies on that duplicate because the runtime-owned layer is independently present.
- The 131,000-byte policy is common and conservative; Codex also checks the exact serialized argument because TOML/JSON escaping can expand it past `execve`'s measured boundary.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Claude's generated file removes instruction text from argv, while Grok and Codex have no measured additive file form. Their inline text remains visible to same-user process inspection and all three runtimes persist consumed text in session artifacts.
- Claude automatic compaction stays `cannot`: the implementation is wired, but two authenticated attempts failed with `too_few_groups`; wiring is not substituted for runtime evidence.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-08-15T16:07:30Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass
