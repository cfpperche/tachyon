# Spec 257 — Notes

## Post-ship residual — Grok runtime (t-7426de, 2026-07-24)

v1 shipped claude + codex only (D10). **t-7426de** adds `src/probe/adapters/grok.ts` (Grok Build `-p --output-format json`), registers it on `ProbeService`, extends Bridge `probe_agent` `runtime` enum with `"grok"`, golden-fixture unit tests + binary-gated `probeSmoke` `--version`, and Cap 13 on `docs/runtimes/parity.md`. OpenCode/Pi/Hermes still out of scope.

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

**Decision:** no decision-grade debate — the probe delivered concrete better designs, not just questions. Probe run: `.agent0/.runtime-state/codex-exec/20260624T185330Z-…/` (external to this repo).

**Ratifications (maintainer):** D10 confirmed (two runtimes, duet-first, resume cut). OQ1–OQ6 all ratified per recommendation — sync cap 120s/ceiling 240s; gitignored bounded-retention artifacts, **no redaction in v1**; lifecycle MVP = cancel + reap-on-restart + concurrency cap, **no auto-retry**; capability-tied worktree isolation (read-only = none); machine output schemas per archetype (non-compliant → `parse_error`); v1 sandbox = runtime-native flags + caller-auth, enforcement layer deferred. Spec is now `/sdd plan`-ready.

## Implementation deviation — separate `ProbeService`, not a merged `AgentRun` (D1)

D1/the plan envisioned one internal `AgentRun { kind: pane|probe }` literally inside `AgentManager`. During implementation that proved the WRONG shape: `AgentManager` is tmux/pane-centric (sessions, control-mode, attention), and a headless captured subprocess shares almost none of that machinery. Forcing the probe into it would entangle the headless lane with pane mechanics — the opposite of clean. So the probe lane is a cohesive **`ProbeService`** that IS the run engine for probes (its own runId mint, storage, cancellation, concurrency cap, reap), with shared observability via `notify` + the per-run store. The spirit of D1 (don't duplicate the engine; one captured-run concept) holds; the letter (one class) was the wrong call. Codex flagged this (#40) as a drift risk for wait/list/kill — accepted as a conscious tradeoff; a future unification can wrap both behind a thin registry if the drift materializes.

## Code review (codex adversarial pass on the implementation)

A second adversarial codex probe reviewed the built code (50 findings; run `.agent0/.runtime-state/codex-exec/20260624T220810Z-…`). **Folded** (commit `8a4f052`): #2 (read_probe_result not-found vs running), #3 (concurrency-cap race — reserve slot before the capability await), #4/#5/#6 (cancel-before-launch + idempotent terminate), #7 (spawn-error → stderr), #9 (claude requires `type:"result"`), #11/#31 (write probes fail closed), #12/#45 (bounded artifact read + capped stdout/stderr), #15 (strict artifact filename), #17 (prune skips in-flight), #19 (reap is honest — no fictitious SIGKILL), #23 (status completed = ok only), #26 (parse_error preserves the answer), #35 (honest truncation pointer), #36 (onComplete can't corrupt a result), #43 (finite budget), #49 (persist caller).

**Deferred, with reasons** (mostly ratified or genuine v1 limits):
- #10 OS sandbox / #33 redaction / #48 per-caller ACL — ratified (OQ6 runtime-native-advisory; OQ2 no-redaction-v1 + workspace-scoped reads). #49 now persists `caller` so the ACL can land later.
- #32 env allowlist — the probed CLIs NEED their own auth env (claude/codex tokens); a careful per-runtime allowlist is a follow-up, not a v1 strip that would break the CLIs.
- #20 process-group kill (grandchildren), #16 realpath/symlink containment, #13 codex artifact atomicity, #24/#25 richer event-stream error classification, #29 absolute-binary-path, #38 atomic result+meta pair, #39 corrupt-JSON distinction, #42 fs-read timeout — defense-in-depth / richer-fidelity follow-ups; logged, not v1 blockers.
- #14/#34 grapheme-safe truncation, #46 stderr-in-diagnostics, #47 cancelAndWait, #50 native size bound — minor.
- #30 caller-controlled cwd — the MCP surface does NOT expose `cwd` (the Bridge pins it to the workspace root); a direct-`ProbeService` containment check is a defense-in-depth follow-up.

## Code review — round 2 (UI surface, task 12)

A focused codex review of the observability UI (inspector panel + sidebar chip + the pure `probeView`) — the webview renders untrusted probed-model output, so XSS/escaping was the priority. 11 findings; the real ones **folded** (commit follows the task-12 commits): a render-race guard (token + disposed flag so a slow `probeView()` can't overwrite fresh HTML), a distinct error state (a load failure no longer masquerades as "no probes"), `esc()` also escaping `'` + `esc(folder)` for the title, a `caller` column, `Math.floor` ages, sorting + excerpt-capping in the PURE VM, and a defensive `ws.probeService?.active() ?? 0` at the sidebar boundary. The "running chip can get stuck" / "O(1) claim" concerns were already covered by the design the reviewer couldn't see — `active()` is `inflight.size` (in-memory) and `launch().finally(delete)` guarantees the decrement; `reap()` reconciles cross-restart orphans.

## Open coordination note

Drafted as spec **257** after checking spec numbers across all worktrees/branches (a parallel agent owns 255 pin-studio-rich-pins + 256 pin-studio-excalidraw on the `tachyon/spec-255-pin-studio-rich-pins` worktree). 257 was the next free number at draft time.
