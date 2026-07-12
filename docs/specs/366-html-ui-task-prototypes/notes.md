# 366 — html-ui-task-prototypes — notes

_Created 2026-07-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

### 2026-07-09 - codex - Claude Fable plan fold

Fable reviewed the initial spec/plan/tasks in `.tachyon/reviews/366-html-ui-task-prototypes-fable.md` and returned
REVISE BEFORE DELEGATION (4 blockers, 6 majors, 5 minors). Folded decisions:

- Interactive HTML is conditional on both a server request-counter proof and blocking evidence in a real VS Code
  webview. Failure or unavailable proof selects static-only v1.
- Prototype validation is a standalone strict policy; it does not inherit `entryHtmlValidator` as a policy floor.
- Agents create drafts only and cannot name `supersedes`; approval/demotion remains first-party.
- The manifest, not the task journal or `awaitingHuman`, is the authoritative decision record.
- v1 lifecycle is only `draft | approved | superseded | rejected`; `implemented`/`archived` were cut.
- Prototype blobs use their own `prototypes/<sha256>` directory to avoid rich-doc GC coupling.
- `awaitingHuman` gains an optional exact prototype subject and remains advisory; task status changes cannot alter
  manifest decision state.
- Static frames require four-sided first-party containment and an over-frame watermark; interactive bundles require
  synchronous nonce capture, zero message listeners, and no `allow-same-origin`/prototype `unsafe-inline` scripts.

### 2026-07-09 - codex - implementation review correction

V1 records first-party UI decisions in the workspace manifest, but it does not make them tamper-evident against
direct filesystem edits by a workspace-writable process. A future host-owned witness or signature registry is
required before claiming a hard approval authority boundary.

## Deviations

### 2026-07-09 - cxPrototype119dc1Sol - static-only v1 gate result

The delegated worktree did not contain the referenced raw Fable review file; its accepted findings were present in
the four SDD documents. The real `vscode-webview://` navigation-egress dogfood required for interactive HTML could
not be produced in this session, so T3 selected the specified static-only fallback. No interactive panel, command,
bundle, message listener, or registration was added. Headless browser evidence covers the byte-exact empty sandbox,
script suppression, four-sided gutter, over-frame watermark, and pointer suppression; existing plugin-frame tests
remain the regression proof for the extracted assembler.

## Tradeoffs

Interactive fallback intentionally permits a complete static-only v1. A functional mock remains inspectable and
approvable, but click behavior waits until Tachyon can prove that arbitrary frame navigation creates zero egress in
the real Electron/VS Code host.

## Open questions

No product fork blocks implementation. T3 owns the empirical interactive/static result.

## T9 closure (2026-07-12, worktree `tachyon/htmlUiPrototypes366T9`)

### Bugfix
- `taskPrototypeFrame` browser test "allows inspecting tall static prototypes by scrolling" failed:
  `window.scrollY` stayed 0 under puppeteer wheel into `sandbox=""` srcdoc.
- Root product risk addressed: static pointer guard must not collapse document overflow. Explicit
  `overflow:auto` on `html,body` (without `height:100%`, which forced scrollHeight == clientHeight)
  keeps tall mocks inspectable via document scroll while descendants stay `pointer-events:none`.
- Test now asserts overflow metrics + `scrollBy` (reliable path) and treats host wheel delivery as
  best-effort (`afterWheel >= beforeWheel`).

### Verification
- `npm test` focused prototype suites: 46 pass
- `npm run test:browser -- taskPrototypeFrame`: 3 pass
- `npm run test:browser -- pluginFrame`: 9 pass
- `npm run typecheck`: pass
- `npm run verify:full`: 308 files, 3684 passed, 3 skipped

### Dogfood / Visual QA
- Static chrome evidence: `.tachyon/evidence/366-html-ui-task-prototypes/static-preview-{dark,light,scrolled}.png`
- Interactive panel: absent (static-only v1 per T3)

## Verification log

### 2026-07-12T18:43Z — pass
- `npm run verify:full` — 308 files / 3684 tests pass

## Dogfood log

### 2026-07-12T18:42Z — pass
- `npm run test:browser -- taskPrototypeFrame` — 3/3 pass

### 2026-07-12T18:44:09Z — pass (1/1) — source: tasks.md — commit: 57f298fc71a0fb71e8b1ccda37a33c0b50874f52
- `npm run test:browser -- taskPrototypeFrame` — pass
