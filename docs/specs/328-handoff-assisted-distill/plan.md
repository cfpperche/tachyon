# 328 — handoff-assisted-distill — plan

_Drafted from `spec.md` on 2026-07-02. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a small Distill workflow to the existing Project Handoff panel. The host will enrich the
`HandoffViewModel` with running AI-agent targets plus supported ad-hoc runtimes. The webview will
render a compact form for target mode, target selection, and an optional instruction. Submitting
the form posts a typed action to the host.

The host validates the target and sends a generated distillation contract either by writing to a
running agent pane or by spawning a dedicated ad-hoc agent. The contract is intentionally narrow:
read `get_project_handoff`, produce a proposed canonical rewrite, ask the human before applying,
then call `set_project_handoff` only with the snapshot's `expected_revision` and
`distilled_through`.

## Key decisions

- **Assist, do not auto-apply** — chosen because handoff is the curated project-state document; rejected host-side auto-write because it would make the owner review path implicit.
- **Reuse pending notes** — chosen because spec 245 already shipped `pending` and `distilled_through`; rejected a new candidate queue because spec 320 was canceled for duplicating the pending lane.
- **Send a contract prompt** — chosen because it works for existing and ad-hoc agents with the tools already exposed; rejected adding new bridge tools because `get_project_handoff` and `set_project_handoff` already have the needed data and CAS.
- **Runtime-owned model list for Codex ad-hoc** — chosen after dogfood exposed that a local CLI default can point at a model unsupported by the authenticated account. The host asks `codex debug models` when rendering/starting the distill flow, so new Codex models appear without a Tachyon release. If discovery fails, the UI falls back to the local CLI default profile.
- **Profile plus read-only command preview** — chosen after Claude/Fable review because it answers which model/command will run without letting the webview pass a raw executable string to the host; rejected editable command text as a trust-boundary and validation expansion.

## Files touched

- `src/webview/HandoffPanel.ts` — assemble distill targets and dispatch existing/ad-hoc distill tasks.
- `src/webview/handoff/{App.tsx,messages.ts,handoffViewModel.ts,handoff.css}` — render the Distill workflow and typed action.
- `src/webview/handoff/distill.ts` — pure prompt builder and input normalization.
- `src/webview/formLogic.ts` — avoids dated concrete Codex model suggestions in Agent Studio.
- `test/unit/handoffDistill.test.ts` — guard the contract prompt and instruction handling.
- `docs/specs/328-handoff-assisted-distill/*` — spec, plan, tasks, notes.

## Risks & unknowns

- The host must not target terminals/build sessions; filter to `kind === "agent"` and running.
- Sending to an existing agent submits the prompt into its pane; if the agent is busy, that is equivalent to any user input into a busy terminal and should be visible.
- The UI is new webview surface area; inspect it visually before closeout.
- Ad-hoc command composition must remain host-owned. The webview sends a profile id, not shell text.
- Codex model discovery can fail when the CLI is missing/old/broken; fallback should be explicit as CLI-configured default, not pretend a concrete model is guaranteed.

## Visual impact

The Handoff header gains a Distill action. The form must stay compact, not push the canonical
handoff out of view unnecessarily, and must be legible in the VS Code dark theme. Capture at least
one screenshot or human dogfood note after installing the VSIX.

Follow-up: ad-hoc mode shows a profile selector and read-only command preview. Visual QA should
cover both a discovered Codex model profile and the CLI-configured fallback.

## Sources consulted

- `docs/specs/245-tachyon-project-handoff/spec.md` — current handoff model and deferred Distill panel idea.
- `docs/specs/320-persistence-handoff-candidates/*` — canceled duplicate candidate-queue idea to avoid.
- `src/bridge/tools.ts` — existing `get_project_handoff` / `set_project_handoff` contracts.
- `src/webview/HandoffPanel.ts` and `src/webview/handoff/*` — current panel host/webview structure.
