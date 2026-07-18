# 402 — pi-activity — plan

_Drafted from `spec.md` on 2026-07-18._

## Approach

1. Add `pi` to the normalized runtime vocabulary and implement `createPiNormalizer(sourcePath)`, following the pure/stateful Claude/Grok adapters: parse one complete JSONL line at a time, retain pending tool metadata plus observed model/effort, and emit only existing normalized event types.
2. Map Pi v3 entries: header/session metadata; message roles (user, assistant, toolResult, bashExecution, custom, summaries); model/thinking changes; compaction/branch summaries; custom messages. Drop custom state, labels and unknown entries.
3. Correlate assistant `toolCall` blocks with `toolResult` messages. Recognize conservative read/write path keys, emit file references at call time and mutations only after non-error results. Treat direct `bashExecution` as a user command plus completion/failure.
4. Map assistant usage/model/stopReason, content images and thinking. Extend the writer blob extractor for Pi's `{type:"image",data,mimeType}` block shape.
5. Register the normalizer in `ActivityLogWriter`; exact path/session attribution already flows from `AgentManager.transcriptPathOf` through `ActivityLogManager`.
6. Add fixtures/unit/integration tests and a real local-provider Pi RPC dogfood that produces a native transcript then sends it through the real normalizer/writer path.

## Key decisions

- **Normalize append chronology, not active-tree projection** — Activity is an append-only audit stream; hiding abandoned Pi branches would require destructive reinterpretation and conflict with durable offsets.
- **Stable entry ID as record provenance** — all events from one Pi line share its `entry.id`, matching `ActivityLog.appendRecord` idempotency.
- **Primer/custom context is not human chat** — classify Tachyon primer, custom messages and synthetic reminders as context/system events.
- **Conservative effects** — a path-bearing read emits `file.referenced`; a mutating tool emits `file.changed` only after a successful correlated result.
- **Unknown means drop** — no fallback to Claude and no durable `raw` bloat.
- **Use existing exact resolver** — no extra directory scan or Activity-specific Pi session selection.

## Files touched

- `src/activity/piNormalizer.ts` — Pi JSONL adapter.
- `src/activity/types.ts` — add Pi runtime ID.
- `src/activity/logWriter.ts` — select Pi adapter and extract Pi image bytes.
- `src/activity/ActivityLogManager.ts` — Pi filename fallback documentation/helper if needed.
- `test/unit/piNormalizer.test.ts`, `test/unit/logWriter.test.ts`, `test/unit/activityLog.integration.test.ts` — mapping, durability and selection.
- `scripts/dogfood/pi-activity.mjs` — real Pi transcript → normalized durable log.
- `docs/runtimes/{pi,parity}.md` — Activity status/evidence.

## Risks & unknowns

- One Pi assistant entry can contain text, thinking, tool calls and usage; all must be appended in one idempotent record.
- Tool results after host restart may lack pending names; degrade to IDs/result status rather than guessing.
- Base64 image payloads must never persist in the normalized JSON event.
- Primer detection must be narrow enough not to hide an ordinary human message discussing Tachyon.

## Visual impact

The existing Activity view gains Pi rows using existing components; no layout or styling changes. Human dogfood will inspect real Pi conversation/tool/usage rows. No separate visual baseline is needed.

## Sources consulted

- Pi `docs/session-format.md`, shipped session manager/types, and real SDD 400/401 RPC transcripts.
- `src/activity/{types,claudeNormalizer,grokNormalizer,logWriter,ActivityLogManager}.ts` and their unit/integration suites.
- SDD 238/239 Activity contracts, SDD 378 model provenance, SDD 400 exact Pi resolution, SDD 401 private homes.
