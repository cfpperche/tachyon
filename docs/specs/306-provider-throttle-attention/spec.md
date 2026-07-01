# 306 — provider-throttle-attention

_Created 2026-06-30._

**Status:** shipped

**Closure:** Shipped 2026-06-30. `AttentionMonitor` gained a 4th state `throttled`, detected via a unified bottom-up tail walk (`classifyAttentionTail` in `src/attention/patterns.ts`) that checks a new, separate `PROVIDER_ERROR_PATTERNS` list against the existing prompt patterns, bottom-most match wins (same-line ties favor error) — fixing a design flaw the codex dueto caught before implementation (two independent full-window scans would have let a stale error line beat a fresher prompt). A sustained-throttle anti-spam notify (`THROTTLE_NOTIFY_DELAY_MS`, 45s) fires once per episode via a second `onChange` call site inside the existing per-agent tick loop. `AgentStatus` gained `"throttled"` (sidebar dot: `--ds-warn` fill, no glow, darker outline) and `src/sidebar/actions.ts`'s `isRunning` predicate was updated so a throttled agent keeps `reanchor`/`reinjectContinuity` (a real gap the dueto caught — `isRunning` is a hand-written check, not a `Record<AgentStatus,...>`, so TS exhaustiveness didn't catch it automatically). Validation: 49 new/updated unit tests (`attention.test.ts`, `agentModel.test.ts`, `sidebarActions.test.ts`) + full suite (141 files / 1899 tests) green, `tsc` main + webview clean, `/sdd verify` passed (logged in `notes.md`). Human dogfood (visual confirmation of the dot/badge/toast in a live pane) left as an opt-in follow-up per the dogfood opt-out in `tasks.md`.

## Intent

_Origin: pin `p-6556de` (by `claude-tachyon`, 2026-06-21). Maintainer confirmed via rule-of-three at scoping time: hitting multiple concurrent agents against LLM providers is Tachyon's normal daily-driver usage, and a rate-limited/overloaded agent going unnoticed is a real, repeated pain, not a speculative one._

A provider error (rate limit / overloaded / "API Error" / 429 / 529) is a blind spot today. `AttentionMonitor` (`src/attention/AttentionMonitor.ts`) only recognizes three states — `working` / `idle` / `needs-input` — driven by CPU activity and a prompt-pattern library (`src/attention/patterns.ts`) tuned for interactive `[y/n]`-style prompts. A provider error is not a process death (the agent stays `running`), is not CPU activity (the pane goes still, same as `idle`), and does not match any prompt pattern — so it silently collapses into `idle`. There is no sidebar signal distinct from "the agent finished and is waiting," and no proactive nudge; a maintainer only discovers it by opening the pane.

"Done" means: a provider-error signature in an agent's pane drives a new, distinct attention state (`throttled`) with its own sidebar dot/badge, and — only if the condition persists past a short anti-spam delay (most CLIs auto-retry on their own within seconds) — a single proactive notification, reusing the same toast mechanism `needs-input` already uses.

## Acceptance criteria

- [x] **Scenario: A stable provider-error signature drives a new `throttled` attention state**
  - **Given** an agent's pane shows a stable (non-changing) bottom-most actionable line matching a provider-error pattern (a contextual match — e.g. "rate limit" / "overloaded" / "usage limit" / a 429-or-529 code near an error/provider/status word — not a bare number)
  - **When** `AttentionMonitor.tick()` runs after the pane has been stable for at least `PATTERN_STABLE_MS`
  - **Then** the agent's state becomes `throttled` (not `idle`, and not `needs-input` even if that same line incidentally also matches a prompt pattern — error wins the tie only when it's the same line)
- [x] **Scenario: A newer prompt below an older error still wins (bottom-most-match rule, folded from the design dueto)**
  - **Given** a pane tail where an earlier line matches a provider-error pattern and a LATER (more bottom) line matches a genuine prompt pattern (e.g. "Rate limit hit..." scrolled up, followed by "Switch provider? [y/n]")
  - **When** `tick()` classifies the tail
  - **Then** the bottom-most matching line wins regardless of category — the agent becomes `needs-input`, not `throttled` — because the error banner is stale relative to the newer prompt
- [x] **Scenario: The sidebar shows `throttled` distinctly from `needs`/`idle`/`running`**
  - **Given** an agent whose `AgentVM.status` is `throttled`
  - **When** the sidebar Agents list renders
  - **Then** the row shows a distinct dot color/style and a badge/label identifying it as throttled — not reusing the `needs` (needs-input) or `idle` visual treatment
- [x] **Scenario: A transient error self-resolves without a notification**
  - **Given** an agent enters `throttled` and the pane content changes (e.g. the CLI's own retry succeeds) before the anti-spam delay elapses
  - **When** `tick()` observes the new content
  - **Then** the state returns to `working` per the existing "new content ⇒ working" rule, and no toast/notify fires for that episode
- [x] **Scenario: A sustained throttle fires exactly one proactive notification**
  - **Given** an agent remains in `throttled` (pane unchanged) past the anti-spam delay
  - **When** `tick()` observes the elapsed time crossing the delay threshold
  - **Then** exactly one toast notification fires for that episode (mirroring the existing `needs-input` "once per episode" contract), suppressed if the agent's terminal is already the active/focused one (same rule `needs-input` already applies)
- [x] **Scenario: Existing `needs-input`/`idle`/`working` behavior is unchanged**
  - **Given** the existing `AttentionMonitor` unit tests and prompt-pattern behavior
  - **When** this spec's changes land
  - **Then** all pre-existing tests still pass unmodified in intent (only additive test cases)
- [x] The provider-error pattern list is a separate, explicit export (not folded into `DEFAULT_PATTERNS`) so a false-positive fix touches one place and doesn't risk the prompt-detection precision spec 188 established.
- [x] The anti-spam delay is a simple exported constant (like `PATTERN_STABLE_MS`) for v1 — no new per-agent config surface (no `tachyon.yml` schema change).
- [x] **(Folded, dueto finding 3)** A `throttled` agent keeps its running-only AI actions (`reanchor`, `reinjectContinuity`) — `src/sidebar/actions.ts`'s running-like predicate treats `throttled` the same as `running`/`needs`/`idle`, so adding the new status doesn't silently strip actions from a live-but-blocked agent.

## Non-goals

- No automatic retry/restart action — this spec is detect + surface only, matching the pin's own phrasing ("opcionalmente push... " for the notify; no mention of an automated retry).
- No per-agent configurability of the provider-error pattern list or the anti-spam delay in v1 (`tachyon.yml` schema unchanged) — if false positives/negatives show up in practice, that's a fast, contained follow-up once the fixed list proves insufficient.
- No parsing of structured error payloads (e.g. reading Claude's own JSON transcript for an explicit error code) — this stays a pane-text pattern match, consistent with how `needs-input` detection already works, so it works uniformly across Claude/Codex/any future runtime without runtime-specific plumbing.
- No changes to the Activity log's transcript normalizers (`claudeNormalizer.ts`/`codexNormalizer.ts`) — those already capture some provider errors post-hoc for the Activity feed; this spec is about the **real-time** sidebar signal, a different, complementary surface.
- No retry-action button/command in this pass (e.g. "restart agent" quick action) — the badge + notification give the maintainer enough to act manually; an action button is a natural, separately-scoped follow-up if it proves needed.

## Open questions

- None — see `plan.md` for the codex design dueto that resolves the pattern-priority and status-vs-badge questions.
