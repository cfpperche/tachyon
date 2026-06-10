# 202 — tachyon-control-mode — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] 1. SPIKE (real socket): nested `#{S:…}` subscription fires on pane death; reply framing under concurrent exec; record findings in notes.md — GATE for the rest
- [ ] 2. `ControlModeClient`: spawn/attach to anchor, parser (%begin/%end/%error, notifications, octal unescape), exec FIFO, dispose
- [ ] 3. Reconnect with backoff + degraded-mode flag; single warning, no spam
- [ ] 4. TmuxService executor routing (control-mode first, execFile fallback); anchor create/cleanup helpers
- [ ] 5. Phase 2 events: %sessions-changed + dead-map subscription → debounced lifecycle.tick(); ticker stays as heartbeat
- [ ] 6. extension.ts + bridge-host wiring; stopAll/deactivate cleanup; 0.4.2
- [ ] 7. Unit suite (scripted streams) + real-socket suite + full integration re-run
- [ ] 8. Live measurement: kill/crash an agent, record detection latency before/after in notes.md; dogfood section

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [ ] Unit suite green (parser, queue, reconnect, unescape)
- [ ] Real-tmux control-mode tests green on the throwaway socket
- [ ] xvfb integration unchanged (21 passing / 1 pending) — behavior preserved
- [ ] Steady-state subprocess spawns ≈ 0 (observed); crash/gone detection ≤ ~1s (measured live)

## Notes
