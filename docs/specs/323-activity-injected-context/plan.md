# 323 — activity-injected-context — plan

_Drafted from `spec.md` on 2026-07-02._

## Approach

1. **Event type**: add `"context.injected"` to `ActivityEventType` + `ActivityPayloads` (`src/activity/types.ts`) with payload `{ text: string; source: "hook" | "developer"; hookEvent?: string; tagged?: boolean; truncated?: boolean; originalLength?: number }` — `hook` = claude hook_additional_context (provably a hook), `developer` = codex developer message. **(Revised per dueto F1)**: codex tag-wrapped developer messages are NOT dropped — they emit with `tagged: true` and the VIEW skips them; the durable log keeps the full audit trail, so a misclassified tag costs a hidden chip (cosmetic), never lost data.
2. **Claude normalizer**: extend `ClaudeRecord` with the `attachment` shape; in the switch, a `case "attachment"` emits `context.injected` when `attachment.type === "hook_additional_context"` and content is non-empty (content is an array of strings — one event per non-empty item, text capped ~4000); every other attachment type keeps falling through to `raw` (log-filtered).
3. **Codex normalizer**: in `handleResponseItem` case "message", the `role === "developer"` branch stops returning unconditionally: it emits `context.injected` with `tagged` computed by a whitespace-tolerant, case/attribute-tolerant tag matcher (dueto F1); developer emissions route through the SAME `markMessage`-style dedupe as user/assistant (key `developer\0text`, dueto F2); `role === "system"` stays dropped.
4. **View**: `activityView.ts` maps `context.injected` to a new item `kind: "injected"` (title = text, capped); the webview activity App renders it as a compact line like the nudge (new codicon entry + a one-line branch, hover "Injected context").

## Key decisions

- **A NEW `context.injected` event, not a generalized `system.nudge`** — the durable log is the audit trail; conflating "Tachyon typed a visible reminder" with "the runtime silently injected context" would erase exactly the distinction the pin asks to see. Render-wise both are compact chips; type-wise they stay separate.
- **Tag-prefix discriminator on codex (`/^<[a-z_ ]+>/`), not the metadata field** — empirically ALL developer messages carry `internal_chat_message_metadata_passthrough` (runtime internals included), so it discriminates nothing; the tag-vs-prose split classified 55/55 sampled messages correctly. Risk accepted: a future runtime injection in plain prose would surface as injected context — which it IS.
- **Promote ONLY `hook_additional_context` on claude** — `hook_success` records carry no content (stdout-less runs), and `task_reminder`/`skill_listing`/etc. are harness plumbing; promoting everything would bloat the feed the same way raw-filtering exists to prevent.
- **Cap text at 4000 chars** (same bound as tool `full`) — hook contexts are one-liners today, but the cap protects the durable log from a pathological hook.

## Files touched

- `src/activity/types.ts` — event type + payload.
- `src/activity/claudeNormalizer.ts` — `ClaudeRecord.attachment` + the attachment case.
- `src/activity/codexNormalizer.ts` — developer-role branch.
- `src/activity/activityView.ts` — `context.injected` → `kind:"injected"` item.
- `src/webview/activity/App.tsx` — icon map entry + render branch.
- Tests: `test/unit/codexNormalizer.test.ts` (developer prose vs tag-wrapped vs system), the claude normalizer suite (attachment promotion vs other attachment types staying raw), activityView mapping case.

## Risks & unknowns

- **R1 — feed noise on session start** (up to 3 chips per SessionStart on claude: owner-record emits nothing, handoff + continuity pointers emit one each). Accepted: 1-2 compact lines per session boundary is the audit value, not noise.
- **R2 — codex tag list drift**: a new runtime wrapper tag with a space/uppercase could slip the regex. The regex accepts `[a-z_ ]+` (covers both observed forms); anything slipping through surfaces as an injected chip — fail-visible, not fail-broken.
- **R3 — old durable logs** have no such events; views of past sessions simply show none (no migration promise).

## Sources consulted

- Investigation record on pin `p-d3d122` + handoff note (2026-07-01) — transcript/rollout record shapes, logWriter raw filter (`logWriter.ts:154`), normalizer drop points.
- Fresh empirical inventory (2026-07-02): 8 recent rollouts — 41 plain-prose developer messages (all hook injections) vs 14 tag-wrapped runtime internals; metadata field present on ALL; AGENTS.md never developer-role.
- `src/activity/{types.ts,activityView.ts,claudeNormalizer.ts,codexNormalizer.ts}`, `src/webview/activity/App.tsx` (nudge render, kind icon map).

## Design dueto (VIA PROBE, runtime codex) — folded

`probe-b94a2f69`, verdict **SHIP-WITH-CHANGES**, 7 findings:

- **F1 (major, folded — design improved)**: silently dropping tag-wrapped developer messages re-creates the invisibility hole for any legitimate injection that starts with markup. Fix adopted: emit EVERYTHING to the durable log with `tagged: boolean`; only the view filters (renders untagged). Misclassification becomes cosmetic. Tag matcher widened: leading whitespace tolerated, uppercase/hyphen/attributes accepted.
- **F2 (major, folded)**: developer emissions go through the same seen-message dedupe as user/assistant (mirrored/replayed records within the 2s window collapse), with fixture coverage.
- **F3 (major, folded in part / rebutted in part)**: claude replay-duplicate risk. Rebuttal: `context.injected` inherits exactly the offset-tailed, append-only guarantees every other claude event (user/assistant/tool) already relies on — it is not weaker; a systemic re-tail bug would duplicate ALL events, not just this one. Folded: the event carries `recordId = rec.uuid` (attachment records have uuids) so downstream dedupe is possible, and one attachment emits ONE event (see F5), minimizing multiplicity.
- **F4 (major, folded)**: consumer audit — `activityView`'s switch ignores unknown types (old builds reading new logs are safe; new builds reading old logs simply show `system.nudge` as before); `ActivitySummary` counts only messages/tools (unchanged); activity-seq-based nudge anchoring advances by 1-2 events per session boundary (negligible vs the nudge lag thresholds). Mixed-log rendering covered by a test with both `system.nudge` and `context.injected`.
- **F5 (minor, folded)**: ONE event per claude attachment (content items joined with newlines) instead of per-item fragments; `truncated` + `originalLength` recorded when the 4000 cap bites.
- **F6 (minor, folded)**: the webview kind→icon map stays an exhaustive typed Record (compile-time coverage); activityView mapping covered by unit test.
- **F7 (minor, rebutted with convention)**: fuzzy-matching attachment-type variants contradicts the codex-normalizer house style ("conservative by design: map observed shapes, ignore unknown without throwing"). Exact `hook_additional_context` match kept; exact-shape fixtures added; unknown variants stay raw by design.
