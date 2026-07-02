# 323 — activity-injected-context — notes

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

### 2026-07-02T13:34:45Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts test/unit/activityView.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-02T13:34:51Z — pass (1/1) — source: tasks.md — commit: 3a5f9d5f9de1e5b3b128f0cd28241d6f11b11525
- `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts -t "injected"` — pass

## Human dogfood log

### 2026-07-02 — pass on codex (maintainer, 0.54.35 loaded after window reload)
Maintainer reloaded the window (the earlier miss: 0.54.35 was installed 90s AFTER the extension host
started, so the host was still running 0.54.34 — process timeline proved it) and resumed the codex agent.
Screenshot confirms the exact designed rendering: two compact ↓ chips right under the "resumed session"
boundary — the PROJECT HANDOFF pointer and the continuity-brief pointer — with NO `<permissions
instructions>`/`<collaboration_mode>` preamble in the feed (tagged:true in the durable log, view-hidden).

### claude-side blocked by upstream (pin p-550ea5)
claude CLI 2.1.198 stopped delivering/recording SessionStart additionalContext on --resume (2.1.197 did;
startup still works — proven via headless probe: VISIBLE + hook_additional_context records). Until fixed
upstream, claude chips appear only at startup//clear boundaries, and — more importantly — resumed claude
agents do not RECEIVE the spec-312 pointers at all (independent of this spec).

### 2026-07-02 — pass on claude STARTUP (maintainer, fresh claude-2 agent, CLI 2.1.198)
A brand-new claude-2 agent's Activity showed the "new session" boundary followed by exactly ONE ↓ chip —
the PROJECT HANDOFF pointer. The continuity chip correctly did NOT appear: claude-2 has no brief yet
("no continuity" badge), and continuity-pointer.cjs only emits when the brief exists — the conditional
emission works end-to-end. Combined with the codex pass above, both runtimes are confirmed; the only gap
is claude RESUME boundaries (upstream 2.1.198 regression, pin p-550ea5).
