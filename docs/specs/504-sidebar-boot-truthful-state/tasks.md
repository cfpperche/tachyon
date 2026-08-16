# 504 — truthful sidebar boot state — implementation tasks

_Proposed by `t-bb152a` (planning only). **Implemented by `t-6e7d8a` on 2026-08-15.**_

## Implementation

- [x] Add fail-before protocol/render tests for unknown, configured-starting, confirmed-unconfigured,
  delayed, failed, ready, and mixed multi-root states.
- [x] Project folder discovery and registry attach lifecycle through the sidebar host message.
- [x] Render the new states; preserve the existing welcome only for confirmed absence.
- [x] Wire per-folder Retry and existing Output diagnostics without duplicating attaches.
- [x] Cover every actor × trigger row from `plan.md`, including folder removal during attach and
  refresh-while-pending.
- [x] Capture reload/absent timing samples and choose the delayed threshold from the sample.

**Localization — the plan said "localize every human-facing string"; that was written against the
pre-monorepo layout and does not apply here.** The sidebar webview is not localized at all today:
`App.tsx` carries plain English strings and imports no `l10n` seam (the existing "No Tachyon
workspace." is one of them). Adding an injection channel for six new strings would be a localization
mechanism for one surface, not a translation — so the new copy matches the code around it. The host
side, which does have `vscode.l10n.t`, keeps using it. Localizing this webview is its own task.

## Verification

- [x] Focused sidebar protocol, host, and render tests fail before and pass after. **Red captured
  before the render changed**: `sidebarWorkspaceSelection.test.ts` failed with
  `expected '<div class="init">…' not to contain 'No Tachyon workspace.'`, the output showing the
  welcome and the Initialize button rendered from an undiscovered empty array.
- [x] Browser checks prove 880 px and 360 px layout for starting, delayed, failed, and mixed
  multi-root — twelve captures, verdict attached as worktree evidence (`concern`: contract met, one
  legibility note on the reused centred `.init` box).
- [ ] Live reload with a configured workspace never exposes Initialize Tachyon while attach is
  pending. **Not run** — a window reload is refused by governed host policy while other agents are
  working, the same wall the plan hit on 2026-08-13. Covered by unit + browser proof instead.
- [ ] Live absent workspace reaches the existing Initialize Tachyon welcome promptly. **Not run**,
  same reason; covered by `boot-unconfigured` at both widths and by the render tests.
- [x] Final full gate attests the implementation tree.

**Headless check:** `npx vitest run test/unit/sidebarBootState.test.ts test/unit/sidebarWorkspaceSelection.test.ts`

**Dogfood-Opt-Out:** the two live-reload rows above are the dogfood this artifact asked for, and both
are blocked by the same governed refusal rather than skipped by choice. Declared here rather than
quietly dropped.

## Visual QA

- [x] Evidence: implementation screenshots at 880 px and 360 px (six boot fixtures × two widths).
- [x] Verdict: starting/delayed/failure copy is legible and the confirmed-empty action remains
  reachable. Long folder names and a spaceless engine-error path both wrap at 360 without
  overflowing; both buttons stay whole.

**Cookbook-Opt-Out:** no new operator surface; this is an internal sidebar lifecycle contract.

## What the implementation changed that the plan did not foresee

- **The `src/` paths in `plan.md` are all stale.** The monorepoization moved them:
  `src/webview/sidebar/*` → `packages/webview-ui/src/webview/sidebar/*`, and `src/extension.ts`,
  `src/shell/*`, `src/webview/SidebarPrototype.ts` → `apps/vscode-extension/src/…`.
- **The root cause was one line the plan did not name**: `main.tsx`'s
  `useState<FleetVM[]>(vscode ? [] : [SAMPLE])`. The welcome was the webview's DEFAULT, so it was
  frame #1 of every reload regardless of what the host later said. Discovery now lives in its own
  state that starts `undefined`.
- **The provider registration moved ahead of the attach loop.** Registering it after meant
  `configured-and-starting` could exist in the model and never be observed in production — by the
  time the view resolved, every folder was already ready.
- **A failed attach used to abort activation entirely.** The loop did not catch, so one bad folder in
  a multi-root window left the sidebar provider unregistered and the other folders unattached. That
  is also why the spec's "startup fails" scenario had no way to render.
- **The dev preview harness had been broken since the monorepoization** and had to be repaired to
  produce the visual evidence: `serve.mjs` serves the repo root, but the bundles it links at
  `/dist/webview/*` now live under `apps/vscode-extension/dist/`, so every fixture rendered
  "PREVIEW SHELL DID NOT MOUNT". Fixed by mapping the `/dist/` prefix.

## The delayed threshold, and the measurement that did NOT justify changing it

5,000 ms is kept. The sample it now rests on, activation → provider registration: 1,666 / 2,875 /
3,479 ms (plan, 2026-08-13) plus **3,944 ms measured for this task** in a real reload with three live
agents (`exthost19`, 2026-08-15) — a new maximum, and still comfortably under 5 s.

The owner's 10–30 s report is **not** this window and 5 s is not the wrong answer to it. Measured
here: the engine half of the first list (`sidebar.view` over the live control socket) is 326 ms
median / 618 ms max, so the whole boot path is ≈4.3 s. What matches the report in magnitude is a
**24,048 ms synchronous-I/O stall of the extension host** recorded ~21 s AFTER activation completed
(`host-event-loop-lag: cause=sync-work elu=0.894 cpuMs=2561`). Different window, different defect —
tracked as **`t-17674a`**, not folded into this one.

The link between them is why 504 pays for itself anyway: while the host is stalled it can post
nothing, so whatever frame is on screen stays there. Before this change that frame was the lie.
