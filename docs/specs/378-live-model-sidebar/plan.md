# 378 — live-model-sidebar — plan

_Drafted from `spec.md` on 2026-07-13. The approach, not the steps (those go in `tasks.md`)._

## Approach

Source the live model from the runtimes' **own transcript stores** through the pipeline that
already tails them (ActivityLogManager 2s poll → per-runtime normalizers → durable per-agent
log → RuntimeOps activity projection), never from pane text. Add a first-class latched model
fact to the projection with an ownership fix (the sidebar path must advance the cursor
itself), then surface it in the sidebar VM with provenance/staleness/divergence as real data.

Design was hardened by a 3-lens adversarial review (correctness/races · honesty/UX ·
migration/simpler); verdicts sound-with-changes, all blocking findings folded into the
decisions below.

## Key decisions

- **Transcript-derived, not pane-scrape** — footers are user-configurable TOML / custom
  statusline scripts / grok box borders; attention selective-capture skips quiet panes;
  `docs/runtimes/hermes.md` prescribes runtime-owned stores. Rejected pane scraping because
  it violates the RuntimeOps invariant that terminal text never becomes protocol data.
- **New `{model, effort?}` fields in the normalized vocabulary** (top-level, latched
  last-observed-wins like `runtimeVersion`) — effort rides the same codex `turn_context`
  record; deferring the *field* (not the UI) forces a second durable-log migration.
  Rejected reusing `runtimeVersion` for all runtimes because claude/codex put the real CLI
  version there and `normalizeRuntimeVersion`'s semver regex drops model ids.
- **No `schemaVersion` bump** — no reader branches on it (logStore flatten/hydrate
  plain-parse each line); additive optional fields are the log's contract. Old records
  never re-normalize → on upgrade agents honestly show `declared` until the next
  model-bearing record (documented).
- **Latch by log append order, not timestamp compare** — the existing
  `observedAt >= versionObservedAt` mixes transcript timestamps with host-clock `loggedAt`
  fallbacks; a host-stamped boundary could out-stamp and suppress a newer real observation.
  The log IS ordered; `observedAt` stays as display metadata.
- **Projection ownership fix** — today only `RuntimeOpsSnapshotService.snapshot()` advances
  the per-agent cursor and it only runs while the RuntimeOps webview is visible
  (`RuntimeOpsView.refresh()` no-ops hidden). Add a cheap per-agent, view-independent
  accessor that advances the shared projection; wire `ActivityLogManager.onAppended`
  (extension.ts:671) to advance → compare the `(label, source, stale, divergence)` tuple →
  refresh the sidebar only on change; the 3s attention full re-push reads the same latched
  instance so a missed refresh self-heals. Rejected: sidebar consuming the full
  `snapshot()` (async, whole-webview payload, CLI detection) or a third independent tailer.
- **Boundary-aware precedence** — `observed > declared > profile`, EXCEPT on a
  session.boundary with a process-rotating lifecycle reason (restarted/started/fork, as
  labeled by logWriter): demote observed until a new observation lands (the new process
  provably reverted to the spawn command). Process-preserving boundaries (unlabeled "new" =
  in-TUI `/clear`; "resumed") keep the observation with `stale: true`. Rejected
  unconditional observed-wins (knowably wrong after `restart --model X`) and
  always-degrade-to-declared (declared is the value that was provably wrong).
- **Divergence is a first-class queryable fact** — keep BOTH declared and observed;
  `divergence = normalize(observed) != normalize(declared)` with the SAME alias table on
  both sides; unify the two parallel declared-parsers (RuntimeOps' `projectModel` regex
  misses `-c model=`; `agentModel.ts` handles it — one shared parser). Rejected silently
  preferring observed: declared-X-observed-Y is governance signal.
- **Open-fallback label policy** — observed ids missing from the alias table render as the
  validated raw/title-cased id (charset/length gate, e.g. `/^[A-Za-z0-9 ._:\/-]{1,64}$/`),
  never "Unavailable". Documented carve-out from the closed-enum invariant: transcript ids
  come from the runtime-owned store, not pane text. Rejected patching three more literals
  into the closed union (per-release maintenance treadmill — the same staleness bug at the
  label layer).
- **Sidechain + synthetic filters** — claudeNormalizer latches `message.model` only from
  assistant records with `isSidechain` falsy and model ≠ `"<synthetic>"`; fixture with an
  in-file `isSidechain: true` record carrying a different model (today sidechains live in
  separate files — the filter guards older CLIs and future formats from a WRONG label).
- **Un-overload `runtimeVersion` now, not later** — grok + opencode emit the model via the
  new field; Activity header and RuntimeOps version column read the new field for those
  runtimes. Rejected the follow-up split: it ships one value under two names and plants a
  silent-loss trap in the Activity header.
- **AgentVM shape: additive siblings** — keep `model: string`, add
  `modelSource? / modelObservedAt? / modelStale? / modelDivergence?`; sole webview render
  site updates with a textual marker (suffix/glyph + tooltip), never styling alone.
  Rejected turning `model` into an object (webview-protocol break for one render site).

## Files touched

- `src/activity/types.ts` — `{model, effort?}` on NormalizedEvent
- `src/activity/claudeNormalizer.ts` — read `message.model` (sidechain + synthetic filters)
- `src/activity/codexNormalizer.ts` — read `turn_context.payload.model` + `effort`
- `src/activity/grokNormalizer.ts`, `opencodeNormalizer.ts` — emit via new field; stop
  smuggling through `runtimeVersion`
- `src/activity/logStore.ts` — hoist `model`/`effort` on flatten/hydrate (mirror runtimeVersion)
- `src/activity/activityView.ts` — header prefers the model field for grok/opencode
- `src/runtimeOps/snapshotService.ts` — model latch (append-order), view-independent
  per-agent accessor, declared-vs-observed divergence
- `src/runtimeOps/types.ts`, `model.ts` — validated-open observed label path; unified parser
- `src/extension.ts` — onAppended: advance shared projection → tuple change → sidebar refresh
- `src/sidebar/agentModel.ts`, `types.ts` — AgentExtras model input; precedence + boundary
  demotion; VM siblings
- `src/webview/SidebarPrototype.ts` — modelOf gather (same pattern as verifyOf/evidenceOf)
- `src/webview/sidebar/*` — row render: observed label + textual provenance marker
- `test/unit/*` — fixtures: claude sidechain/synthetic/multi-model, codex turn_context,
  grok model_id, boundary demotion, projection-advance-with-RuntimeOps-closed, label fallback

## Risks & unknowns

- `extension.ts` / `SidebarPrototype.ts` are wide files — keep diffs surgical (owns-scoped).
- Interim honesty on upgrade: pre-existing logs yield `declared` until the next observation
  (documented, honest).
- Codex per-turn latency: a mid-turn switch shows the old model until the next
  `turn_context` — `observedAt` + docs make it honest.
- codex 0.144 live `/model` emission and grok switch-forces-new-session are unverified live
  (open questions in spec.md; historical multi-model evidence is strong).
- RuntimeOps panel incoherence (its model column stays declared-only this spec): stated
  follow-up; the projection is exposed so the follow-up is small.

## Visual impact

The sidebar agent row's model suffix becomes live and gains a textual provenance marker
(e.g. `· declared` before first observation, a stale/divergence glyph + tooltip). What
could look wrong: marker crowding the row at narrow widths; label overflow with raw ids.
Proof: screenshot of the sidebar with a live fleet showing observed labels (and one
declared/pre-first-turn row) attached to notes.md / evidence channel.

## Sources consulted

- src/sidebar/{agentModel,types}.ts · src/webview/{SidebarPrototype,ActivityLogManager,RuntimeOpsView}.ts
- src/activity/{types,claudeNormalizer,codexNormalizer,grokNormalizer,opencodeNormalizer,logStore,logWriter,activityView,sessionOwners}.ts
- src/runtimeOps/{types,model,snapshotService}.ts · src/runtime/runtimeProfile.ts · src/extension.ts:671
- docs/runtimes/parity.md (model-label normalization seam) · docs/runtimes/hermes.md (prefer runtime-owned stores)
- On-disk empirical: ~/.claude/projects/*.jsonl (message.model 1050/1050; multi-model sessions),
  ~/.codex/sessions/**/rollout-*.jsonl (turn_context model+effort; session_meta/token_count carry none),
  ~/.grok/sessions/*/*/chat_history.jsonl (assistant.model_id) + summary.json/events.jsonl
- Adversarial review: workflow wf_6990db76-7a8 (3 lenses, sound-with-changes ×3)
