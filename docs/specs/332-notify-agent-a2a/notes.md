# 332 — notify-agent-a2a — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T20:03:33Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts test/unit/spawnContract.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-02T20:03:42Z — pass (1/1) — source: tasks.md — commit: 8c9d603bdcc94a298add4cbeb5ef2eb067badaf5
- `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts -t "sanit"` — pass

## Human/live dogfood log

### 2026-07-02 — pass (live end-to-end, maintainer + claude as recipient)
Fresh ad-hoc child (haiku, `dogfood332`, parent=claude) spawned under 0.54.45:
1. **Brief guidance ✅** — the child's opening brief contained the exact notify_agent line, composed
   outside the truncatable budget ("in ADDITION to (not instead of) your normal completion reporting").
   (The haiku probe initially claimed it was absent — verified false by reading its transcript.)
2. **Delivery + wake ✅** — `notify_agent(to:"claude")` typed `[tachyon] dogfood332 → claude: dogfood
   332 OK…` into the parent's pane MID-TURN; the runtime queued it and delivered it as the next turn
   input — the parent woke with the summary in hand. Zero polling.
3. **Deliberate-kill suppression ✅** — `kill_agent(dogfood332)` produced NO death poke (expectedDeath
   suppression working).
4. **Cosmetic gap (noted, non-blocking)** — a MID-TURN delivery is recorded as queue-operation + a
   wrapped user record, which misses `isTachyonNudge`'s string-startsWith classification → renders as
   a user message instead of a nudge chip in the recipient's Activity. Idle-recipient deliveries (string
   content) classify correctly. Follow-up material for the nudge classifier, spec-323 family.
5. **Session-staleness observation** — agents whose MCP handshake predates the extension reload don't
   see the new tool (claude's own session lacked notify_agent); fresh spawns see it immediately.
