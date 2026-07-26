# 462 — claude-profile-capabilities — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Decisions

- Added `skill` to host-custodied grants, but require it only for Claude so existing Codex profiles
  retain their shipped contract.
- Claude hooks use `parseClaudeHooksBlock`; this admits `PostToolUseFailure` and rejects Codex-only
  `statusMessage` rather than claiming the shared JSON shape makes runtime semantics identical.
- The canonical materializer removes the prior manifest before any projection write and publishes a
  new manifest only after settings/hooks, strict MCP and the captured skill tree are complete.
- Removing all capability selections also removes the prior skill tree and provenance root, preventing
  a stale manifest from attesting a generation that the current profile no longer selects.
- Strict MCP combines only selected granted servers and the current host-custodied Bridge. Ambient
  workspace `.mcp.json` remains outside the projection.

## Evidence

- Focused suite: 560 tests passed across resolver, loader, harness and AgentManager lifecycle.
- Lifecycle regression mutates stale settings/hooks, skills, MCP and manifest between fresh, restart
  and resume, then proves the selected generation is restored on all three paths.
- A deliberately malformed captured skill fails before manifest publication, proving partial output
  is not attestable as a complete generation.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
