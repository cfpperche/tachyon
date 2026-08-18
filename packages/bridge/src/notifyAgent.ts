/**
 * The agent→agent notice envelope. The composition itself moved to
 * `@tachyon/engine/notify/agentNotice.js` under t-b47fb2 fatia 2: the ENGINE now has to compose the
 * same line when it reconstitutes an undelivered doorbell from `.tachyon/doorbells.jsonl` at boot, and
 * `packages/bridge` depends on `packages/engine` rather than the other way round.
 *
 * Moved rather than copied on purpose. A reconstituted notice must be byte-identical to the one the
 * pane would have received — the queue's dedup key and `stagedQueuedNoticePresent`'s retry comparison
 * are both exact line matches, so two composers that drift by a space would silently turn a retry into
 * a duplicate. This file stays as the Bridge's import path so `notify_agent`'s own call sites and the
 * existing tests keep naming the module they always named.
 */
export {
  AGENT_NOTICE_LINE_CAP,
  AGENT_SUMMARY_CAP,
  agentSummaryRefusal,
  composeAgentNotice,
  composeBoundedAgentNotice,
  formatNoticePointer,
  prepareAgentSummary,
  sanitizeAgentSummary,
} from "@tachyon/engine/notify/agentNotice.js";
