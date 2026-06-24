# Spec 257 — Notes

## Why this exists (design origin)

Tachyon's A2A surface (`spawn_agent` / `wait_for_agent` / `read_output`) is built for **one** execution shape: a persistent CLI in a tmux pane, observed by scraping. That is the right model for a teammate you watch — and the wrong one for a **bounded probe** whose value is a clean captured answer.

The gap was surfaced while reasoning about how a second-model "duet" actually works: the persistent-pane path forces the caller to poll a coarse lifecycle state and then parse terminal chrome, over multiple turns, with no structured result, no error classification, and no provenance. Each supported runtime already ships a non-interactive mode that returns a clean final message + a meaningful exit status — Tachyon simply never invokes it. This spec closes that.

## Key architectural bet

The capture *mechanics* differ per runtime (a result-JSON field vs a last-message file), but the *contract* is uniform: run bounded → hand back a clean final message + a success/error classification. So the probe carries a **neutral result shape** populated by a **per-runtime adapter** — the same common-denominator pattern the plugin capabilities (250/251/254) and the Bridge registration adapters already use. No new abstraction is invented; the existing adapter seam is extended.

## Robustness lesson to encode (do not lose)

A runtime can exit non-zero with a **structured error result that lives in stdout / the last-message file** (budget exhausted, refusal, max-turns). That is a *result*, not a silent death. The adapter MUST set `isError` + `resultSubtype` and lift the error text into `lastMessage`, so a probe that hit its budget never reads back as an empty success. Build a forced-budget-hit case into the S2/S6 dogfood.

## Relationship to existing surface

- **Complements, does not replace** `spawn_agent`. Two lanes: persistent pane (watch) vs captured probe (answer).
- **Reuses** the adapter pattern in `src/registration/adapters.ts`, `src/plugins/adapters/`, `src/resume/adapters.ts`.
- **Unblocks** robust AI nodes in `src/pipeline/` and structured input for `verify_agent` (phase 2).

## Open coordination note

Drafted as spec **257** after checking spec numbers across all worktrees/branches (a parallel agent owns 255 pin-studio-rich-pins + 256 pin-studio-excalidraw on the `tachyon/spec-255-pin-studio-rich-pins` worktree). 257 was the next free number at draft time.
