# 189 — tachyon-fixed-port-idempotent-registration — tasks

_Generated from `plan.md` on 2026-06-09. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Bridge: derivePort + start(preferredPort) with EADDRINUSE fallback + usedFallback flag; unit tests
- [x] 2. Config/schema: settings.bridgePort (1024–65535) + validation tests
- [x] 3. Adapters: alreadyRegistered detectors + upToDate offers; merge-preserves-foreign-servers tests
- [x] 4. extension.ts: early config load, preferred-port wiring, fallback warning, idempotent no-modal connect, reload hint on port change
- [x] 5. Integration: clipboard-read of Bridge URL == derived port for the fixture workspace
- [x] 6. Docs: README + examples

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 189 acceptance boxes verified (unit + integration)
- [x] Full suite green (typecheck/build/vitest/xvfb integration)

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
