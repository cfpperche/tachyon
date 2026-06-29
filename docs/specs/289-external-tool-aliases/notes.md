# 289 — external-tool-aliases — notes

_Created 2026-06-28._

## Implementation (2026-06-28)

Engine-first prerequisite for the diagram plugin (288). Shipped in commit `be94965` (+ fold commit below):

- `manifest.ts` — `ExternalToolDecl.names?: string[]` + the shared `normalizeCandidateNames(raw, where, errors)`
  validator (EXEC_NAME_RE `^[A-Za-z0-9][A-Za-z0-9._-]*$`, cap `MAX_EXTERNAL_NAMES=8`, dedupe order-preserving,
  ≤128 chars, `[]`/omitted ⇒ undefined, over-cap/malformed ⇒ error → fail-closed).
- `externalTool.ts` — `candidateNames(key, names?)` (the ONE candidate-derivation point); `detectExternalTool` loops
  candidates returning the first TRUSTED + detect-passing (skips untrusted/detect-failing, aggregates reasons);
  `detectExternalToolPresence` (spawn-free) loops candidates the same way (trusted, no detect); `resolveExternalTool`
  feeds the lock's `names`.
- `lockfile.ts` — `ExternalToolReqLock.names?` persisted; parse reuses `normalizeCandidateNames` (same contract).
- `engine.ts`/`consentViewModel.ts`/`viewModel.ts` — `names` + `resolvedPath` surfaced on
  `ExternalToolStatus`/`ConsentExternalTool`/`ExternalToolVM` (D6 audit disclosure); the engine records `d.names`.
- `PluginsPanel.ts` — `externalStatuses` caches by name+names (NUL-joined) + passes `req.names` to the spawn-free check.
- `App.tsx` — drawer + installed card show the candidate set + resolved path.

## Impl codex dueto (2026-06-28, commit be94965) — SHIP-WITH-CHANGES, all folded

No BLOCKER/HIGH; anti-spoof explicitly confirmed clean (every accepted candidate is clean-PATH resolved +
`isTrustedExecPath` in BOTH paths), detect fall-through correct, cache keyed by NUL (no collision), back-compat intact.

- **MEDIUM — lockfile validation was looser than the manifest** (no regex/cap/dedupe → a hand-edited lock could carry
  unbounded/garbage names; not injection but a fail-closed/resource-boundary violation). Fix: extracted
  `normalizeCandidateNames` and reuse it in BOTH `parseExternalToolDecl` (manifest) and `parseExternalToolReqLock`
  (lockfile) — identical contract. Test: a corrupt lock with a path-separator candidate is rejected fail-closed.
- **LOW — card resolvedPath could overclaim for a detect-tool** (the card is spawn-free/detect-blind, so it can't
  know the runtime-winning candidate). Fix: `buildExternalStatuses` surfaces `resolvedPath` ONLY for a NO-detect tool
  (where the spawn-free resolve is authoritative, e.g. Chrome); a detect-tool shows present/missing without a path
  claim. Test added. (The present-approximation for detect-tools is pre-existing accepted 287 behavior — the card is
  a cheap indicator; the runtime fail-closes via `detect`.)

Full suite 1836 green; typecheck (engine + webview) + engine-boundary green.

## Note — concurrent agent

Built while another agent was mid-refactor in the same working tree (domainActions extraction; disjoint files).
Committed staging ONLY the 289 files; the other agent's uncommitted work was left untouched (owner paused it).
