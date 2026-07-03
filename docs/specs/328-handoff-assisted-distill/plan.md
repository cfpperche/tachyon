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
- **Runtime default plus owner-supplied args** — chosen after dogfood showed provider/model catalogs are too volatile for Tachyon to own. The UI offers Codex/Claude runtime defaults and a bounded one-line argument field for runtime-native overrides such as `--model ...`.
- **Read-only command preview** — chosen because it answers which command will run without letting the webview choose an arbitrary executable; rejected provider API keys/catalogs and a Tachyon-shipped model snapshot as ongoing maintenance traps.

## Files touched

- `src/webview/HandoffPanel.ts` — assemble distill targets and dispatch existing/ad-hoc distill tasks.
- `src/webview/handoff/{App.tsx,messages.ts,handoffViewModel.ts,handoff.css}` — render the Distill workflow and typed action.
- `src/webview/handoff/distill.ts` — pure prompt builder, ad-hoc command composition, and input normalization.
- `test/unit/handoffDistill.test.ts` — guard the contract prompt and instruction handling.
- `docs/specs/328-handoff-assisted-distill/*` — spec, plan, tasks, notes.

## Risks & unknowns

- The host must not target terminals/build sessions; filter to `kind === "agent"` and running.
- Sending to an existing agent submits the prompt into its pane; if the agent is busy, that is equivalent to any user input into a busy terminal and should be visible.
- The UI is new webview surface area; inspect it visually before closeout.
- Ad-hoc command composition must remain host-owned. The webview sends a profile id plus bounded one-line arguments, not an executable path.
- Runtime argument validity belongs to the selected CLI/provider account; Tachyon should surface CLI errors rather than trying to maintain provider model catalogs.

## Visual impact

The Handoff header gains a Distill action. The form must stay compact, not push the canonical
handoff out of view unnecessarily, and must be legible in the VS Code dark theme. Capture at least
one screenshot or human dogfood note after installing the VSIX.

Follow-up: ad-hoc mode shows a runtime selector, optional runtime arguments, and a read-only command preview. Visual QA should cover the empty-args default and a model-override example.

## Sources consulted

- `docs/specs/245-tachyon-project-handoff/spec.md` — current handoff model and deferred Distill panel idea.
- `docs/specs/320-persistence-handoff-candidates/*` — canceled duplicate candidate-queue idea to avoid.
- `src/bridge/tools.ts` — existing `get_project_handoff` / `set_project_handoff` contracts.
- `src/webview/HandoffPanel.ts` and `src/webview/handoff/*` — current panel host/webview structure.
