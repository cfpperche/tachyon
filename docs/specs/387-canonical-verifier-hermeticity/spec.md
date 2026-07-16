# 387 — canonical verifier hermeticity

_Created 2026-07-15 for task `t-5c7061`._

**Status:** shipped

## Problem

Canonical verification runs project commands in independent tracked-only clones, but Tachyon's own
project preparation did not build ignored `dist/` artifacts. Its verifier-owned temporary path also
made test-created Unix socket names exceed Linux's AF_UNIX limit, and persisted diagnostics kept only
the first output line, allowing an incidental warning to hide the real failure.

## Acceptance criteria

- [x] A tracked project preparation command installs locked dependencies and builds required artifacts.
- [x] BASE and HEAD retain separate private clone, cache and temporary roots, with existing ownership,
  symlink, permission, abandoned-owner and cleanup checks.
- [x] Socket fixtures remain valid under long verifier temp paths without changing production socket guards.
- [x] Failed commands retain bounded output tails and explicit timeout/signal facts in command evidence and blockers.
- [x] Regression tests cover preparation, long-parent socket compatibility and actionable diagnostics.

## Product invariant assessment

Affected Product Invariants: none — this changes generic/project-owned verification mechanics and
diagnostics, not PI-001's project-guidance ownership promise or fixed oracle.

## Non-goals

- Changing production socket path validation, verification authority, or oracle semantics.
- Treating the verifier as a filesystem sandbox or hiding arbitrary project output as secret data.

**Closure:** Shipped tracked install/build preparation, long-TMPDIR-safe socket fixtures and bounded actionable verifier diagnostics; canonical BASE RED / HEAD GREEN dogfood accepted without waiver.
