# 332 — notify-agent-a2a — tasks

_Generated from `plan.md` on 2026-07-02. NOT started — awaiting the maintainer's implementer assignment._

## Implementation

- [ ] `src/bridge/notifyAgent.ts` (pure): sanitizer (C0/C1, ESC/OSC, U+2028/29/0085, bidi, CR/backspace — allowlist printable+space) → collapse → trim → cap 500 → envelope `[tachyon] <from> → <to>: <summary>`.
- [ ] `src/bridge/tools.ts`: `notify_agent {to, summary, agent}` — resolve via the SAME path as write_input (`manager.session` + `hasSession`) + `kindOf(to)==="agent"` gate + self-notify rejection; description warns "best-effort pane input, not a message bus; unsafe for agents actively being typed into". Update spawn_agent's description guidance.
- [ ] `src/bridge/spawnContract.ts`: parent-aware guidance line composed OUTSIDE the truncatable budget (reserved length); keeps human-facing completion reporting alongside.
- [ ] `src/workspace/Workspace.ts`: death poke on LifecycleMonitor edges with `expectedDeath` suppression set fed by kill/dismiss paths.
- [ ] Tests: `test/unit/notifyAgent.test.ts` (sanitizer char classes: U+2028, U+2029, U+0085, ESC, OSC, CR, backspace, bidi override; envelope shape; caps), spawnContract over-cap regression (guidance survives), death-poke suppression logic (pure part).

## Verification

- [ ] Sanitizer: every hostile char class stripped; envelope provably single-line; provenance prefix unspoofable (summary after colon only).
- [ ] Brief: over-cap brief keeps the notify_agent guidance intact; parent name interpolated only when parent given; human-reporting guidance retained.
- [ ] Tool: not-running → structured fail; terminal target → rejected; self-notify → rejected; ad-hoc child target → resolves (same as write_input).
- [ ] Death poke: crash/clean-exit/vanish with live parent → one poke; kill_agent/dismiss → suppressed; dead parent → no-op.
- [ ] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts test/unit/spawnContract.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts test/unit/spawnContract.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/notifyAgent.test.ts -t "sanit"`

**Human dogfood (dueto F8 matrix):** After shipping: from claude, `notify_agent(to:"codex", …)` and vice-versa, covering {idle composer, composer with a typed draft (observe concatenation — documented limitation), ~500-char envelope, unfocused pane}; spawn an ad-hoc child with parent set, let it finish → parent receives the brief-taught notification; kill a child deliberately → NO poke; crash a child (exit 1) → parent poked once. Confirm claude recipients render the envelope as a system.nudge chip in Activity.
