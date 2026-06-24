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

## Probe review + adjudication (draft → probe-reviewed)

An adversarial cross-model probe (instructed to disagree, not validate; structured findings output) attacked the first draft and returned 24 prioritized findings. Adjudicated — folded the strong ones, pushed back on the over-reach:

**Reframes folded:**
- The original D2 ("separate primitive vs mode flag") was a **false binary** → unify the *internals* (one `AgentRun`, `kind: pane|probe`), keep a thin distinct `probe_agent` tool over it (D1/D2).
- The leaky sync/async auto-fallback → **one stable envelope** `{ runId, status, result? }` on every call, explicit `wait` (D3).
- **The headline correction:** the primitive is NOT "clean message + exit status" — it is **lifecycle + a normalized failure taxonomy + caller policy + provenance**. The old `resultSubtype` was a **Claude-shaped leak** → a Tachyon-owned `terminationReason` taxonomy with `native` for runtime specifics (D4).
- Execution substrate → engine-managed subprocess, tmux an optional mirror, NOT headless-in-a-pane (D6).
- New first-class concerns the draft omitted: cross-runtime **security/authorization** (D8), artifact **retention/redaction** (OQ2), **lifecycle edges** (OQ3), payload-**size** limits (D9), CLI **versioning**/compat probe (D5), stdout **noise** (read Tachyon-owned artifacts, D5).
- **OQ8 → promoted to a decision (D7):** structured brief + output contract **selectable by archetype** (`adversarial-review` carries the anti-bias guard; `factual-verify` carries anti-fabrication). The anti-bias guard becomes a property of the archetype, not something a caller hand-writes each time. Start with two; add by demand.

**Pushed back on (probe over-reach):**
- "One-runtime MVP" — rejected: the cross-runtime duet IS the thesis; a single runtime proves capture, not value. Keep two adapters; defer UI/budget polish instead (D10).
- "Full policy/sandbox framework + isolated worktree for every probe" — right direction, too heavy for v1; kept as OQ4/OQ6, not v1 requirements.

**Decision:** no decision-grade debate — the probe delivered concrete better designs, not just questions. Two maintainer calls remain (D10 **[CONFIRM]**: two-runtime scope; duet-first consumer). Probe run: `.agent0/.runtime-state/codex-exec/20260624T185330Z-…/` (external to this repo).

## Open coordination note

Drafted as spec **257** after checking spec numbers across all worktrees/branches (a parallel agent owns 255 pin-studio-rich-pins + 256 pin-studio-excalidraw on the `tachyon/spec-255-pin-studio-rich-pins` worktree). 257 was the next free number at draft time.
