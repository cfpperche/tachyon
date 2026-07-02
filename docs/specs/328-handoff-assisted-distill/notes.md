# 328 — handoff-assisted-distill — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-02: The host sends a prompt contract instead of rewriting from the extension process. This keeps the human review loop explicit and reuses `get_project_handoff` / `set_project_handoff`.
- 2026-07-02: Existing-agent distill submits the prompt immediately; ad-hoc distill spawns a dedicated agent. Both paths carry the same contract.
- 2026-07-02: Claude/Fable probe rejected an editable raw command field as a trust-boundary regression. The refinement uses structured profile ids from the webview and host-owned command resolution.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- None so far.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Runtime discovery was left out of this pass. The UI offers `codex` and `claude`; missing binaries fail through the existing spawn path. This keeps the handoff v2 slice focused on the workflow instead of Agent Studio detection logic.
- Editable custom commands were left out deliberately. The product need was visibility into the model/command, so profile + read-only preview solves it without adding shell parsing or arbitrary flag injection.

## Verification log

- 2026-07-02: `npm test -- test/unit/handoffDistill.test.ts test/unit/handoffViewModel.test.ts test/unit/webviewPreviewRoutes.test.ts` passed, 26 tests.
- 2026-07-02: `npm run typecheck` passed.
- 2026-07-02: `npm run build` passed.
- 2026-07-02: `npx @vscode/vsce package` passed and produced `/home/goat/tachyon/tachyon-0.54.42.vsix`.
- 2026-07-02: After profile refinement, `npm test -- test/unit/handoffDistill.test.ts test/unit/handoffViewModel.test.ts test/unit/webviewPreviewRoutes.test.ts` passed, 27 tests.
- 2026-07-02: After profile refinement, `npm run typecheck` passed.
- 2026-07-02: After profile refinement, `npm run build` passed.
- 2026-07-02: After profile refinement, `npx @vscode/vsce package` passed and produced `/home/goat/tachyon/tachyon-0.54.43.vsix`.

## Visual QA log

- 2026-07-02: Used the webview preview harness at `http://127.0.0.1:5174/scripts/webview-preview/index.html?view=handoff&fixture=default`.
- 2026-07-02: Captured and inspected the Distill-open state from the preview harness. Verdict: pass for this slice; Distill sits in the header, the form is compact, and canonical handoff content remains visible below it.
- 2026-07-02: Re-captured ad-hoc mode after profile refinement. Verdict: pass; `Profile` and `Command preview` answer which command/model will run while keeping the form compact.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
