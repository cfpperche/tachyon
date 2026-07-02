# 323 — activity-injected-context

_Created 2026-07-02._

**Status:** shipped

**Closure:** Shipped 2026-07-02. Injected context is now visible in the Activity feed on both runtimes via a new `context.injected` event: the claude normalizer promotes `hook_additional_context` attachment records (one event per attachment, items joined, 4000-char cap with truncated/originalLength, uuid recordId); the codex normalizer emits ALL developer-role messages through the shared seen-message dedupe, marking runtime preamble `tagged` via a tolerant tag matcher — the durable log keeps everything (audit trail), the view renders only untagged (a misclassification costs a hidden chip, never lost data — the probe dueto's key improvement over the original drop-tagged design). The view maps untagged events to a new compact "injected" chip (exhaustively-typed icon map). Design dueto via probe (probe-b94a2f69, runtime codex): SHIP-WITH-CHANGES, 6 findings folded, 1 rebutted (fuzzy attachment-type matching vs the normalizer's observed-shapes convention). Codex discriminator resolved empirically pre-spec: tag-vs-prose split (55/55 in sampled rollouts); the metadata field discriminates nothing. Validation: 9 new tests across the 3 suites, full suite 141 files/1972 tests green, tsc clean, verify+dogfood logged. Human dogfood (chips visible after next VSIX install/restart) pending.

## Intent

_Origin: pin `p-d3d122` ("Activity captura o que é injetado na seção?"), investigated 2026-07-01: it does NOT._

Injected context is invisible in the Activity feed on both runtimes. On Claude, hook `additionalContext` (user hooks AND Tachyon's handoff/continuity pointers) lands in the transcript as `type:"attachment"` records that the normalizer emits as `raw` — which the log writer filters from the durable log. On Codex, injections land as `response_item` messages with `role:"developer"`, which the normalizer explicitly drops. The irony: the only injected content Activity ever captured was the legacy visible `[tachyon]` tmux nudge (`system.nudge`) — and spec 312 retired it in favor of silent hooks, so persistence nudges became invisible to the human (intended) AND to the audit trail (not intended). Today nobody can answer "why did the agent suddenly read HANDOFF.md?" from the feed.

Empirical grounding for the Codex discriminator (the investigation's open question): in real rollouts (8 most recent), ALL developer-role messages carry `internal_chat_message_metadata_passthrough` — including runtime internals — so that field discriminates nothing. What does: runtime preamble is tag-wrapped (`<permissions instructions>`, `<collaboration_mode>`), hook injections are plain prose (41 plain-prose vs 14 tag-wrapped, zero misclassified in sample); AGENTS.md/user_instructions never appear as developer-role messages at all.

"Done" means: hook-injected context renders in the Activity feed as a compact system chip (like the old nudge line) on both runtimes, without dumping runtime preamble into the feed, and without changing what agents receive.

## Acceptance criteria

- [x] **Scenario: Claude hook additionalContext appears in Activity**
  - **Given** a Claude transcript line `{type:"attachment", attachment:{type:"hook_additional_context", content:[...]}}`
  - **When** the normalizer processes it
  - **Then** it emits a `context.injected` event carrying the injected text (bounded), which the durable log KEEPS (not raw-filtered) and the view renders as a compact chip
- [x] **Scenario: Codex hook injection appears in Activity**
  - **Given** a Codex rollout `response_item` message with `role:"developer"` whose text is plain prose (no leading `<tag>`)
  - **When** the normalizer processes it
  - **Then** it emits `context.injected` with the text (bounded)
- [x] **Scenario: Codex runtime preamble stays out of the feed**
  - **Given** a developer-role message whose text starts with a `<tag>` wrapper (e.g. `<permissions instructions>`, `<collaboration_mode>`)
  - **When** the normalizer processes it
  - **Then** NO event is emitted (dropped as today)
- [x] **Scenario: other hook attachment records stay quiet**
  - **Given** Claude `attachment` records of other types (`hook_success` with empty content, `task_reminder`, `skill_listing`, …)
  - **When** the normalizer processes them
  - **Then** they remain `raw` (filtered from the durable log) — only `hook_additional_context` is promoted
- [x] The Activity view renders `context.injected` as a compact one-line chip (distinct from nudge/message), title capped; the existing `system.nudge` behavior is unchanged.
- [x] Claude `system`/`user`/`assistant` record handling and Codex user/assistant/tool handling are unchanged (additive cases only; existing normalizer tests pass unmodified in intent).

## Non-goals

- No capture of `<system-reminder>` blocks, `task_reminder` attachments, or isMeta records — hook `additionalContext` (claude) and plain-prose developer messages (codex) only; widening the net is a follow-up once this proves useful.
- No retroactive backfill of existing durable logs.
- No change to what agents receive — this is observability only.
- No UI filtering/toggles for injected chips in v1.

## Open questions

- None — the codex-side discriminator (the investigation's open question) was answered empirically before this spec was opened; see Intent + plan.md dueto fold.
