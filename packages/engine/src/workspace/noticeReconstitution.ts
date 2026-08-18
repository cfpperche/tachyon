/**
 * t-b47fb2 fatia 2 — rebuild the pending notice queue from the durable witness at boot.
 *
 * ## The defect, measured
 *
 * `NoticeQueue` keeps the queue exclusively in `private readonly queues = new Map<…>`. Fatia 1
 * (`docs/research/t-b47fb2-dreno-de-notice-perdida.md`) measured the consequence rather than guessing
 * it: three completion doorbells rang on 2026-08-17, all three are in `.tachyon/doorbells.jsonl`, and
 * none ever reached the recipient's pane — the `0.93.9 → 0.93.10` instance swap at 20:07:06Z destroyed
 * everything still pending. Nothing in the diff fixed it and nothing expired it; the queue simply
 * stopped existing. It happened again on 2026-08-18 at 11:37:07 (`t-83d04e`).
 *
 * `t-a281e7` narrowed ONE door by making resume and restart refuse an agent mid-turn. The ENGINE
 * restart is a different door and still destroys the queue, so this is what closes the case: restart
 * stops being a silent discard operation.
 *
 * ## Why this is a plan and not a side effect
 *
 * Everything here is a pure function of (trail, cursor file, live agents). The Workspace does the I/O
 * and the enqueueing; this decides WHAT. That split is what lets the negative control — "an already
 * delivered notice is NOT re-delivered after the restart" — be a table test rather than an
 * engine-restart integration run, and the negative control is the half that matters: swapping a loss
 * for a flood would pass every positive test.
 */

import { composeBoundedAgentNotice } from "../notify/agentNotice.js";
import type { DoorbellEvent } from "./doorbell.js";
import type { NoticeCursorFile } from "./noticeCursor.js";
import { noticeCursorFor } from "./noticeCursor.js";

export interface ReconstitutedNotice {
  /** The recipient — the agent whose queue this goes back into. */
  target: string;
  /** The exact line the pane would have received, composed by the one composer (see `agentNotice.ts`). */
  line: string;
  /** The sender, for the queue's dismissed-sender / delayed-provenance logic. */
  from: string;
  /** The witness timestamp. Carried through to the queue item so DELIVERY can advance the cursor. */
  at: string;
  /** `Date.parse(at)` — the queue's `createdAt`, so the delivered line is marked delayed, never fresh. */
  createdAt: number;
}

export interface NoticeReconstitutionPlan {
  restore: ReconstitutedNotice[];
  /**
   * Doorbells that are pending by the cursor but carry no witnessed summary, so the line they would
   * have delivered cannot be reproduced. Counted rather than dropped in silence: inventing an envelope
   * for content nobody recorded would be worse, and a silent skip is the shape of defect this whole
   * task exists to remove. In this workspace 2,091 of 3,291 rows predate spec 493's `summary` field —
   * all of them older than any baseline, so this is a pathological/hand-edited path in practice.
   */
  contentless: number;
}

export interface NoticeReconstitutionInput {
  /** The durable trail, `readDoorbellEvents` order (file order). */
  events: readonly DoorbellEvent[];
  /** Agents with a LIVE session at boot. A name with no session has nothing to be handed a notice. */
  agents: readonly string[];
  /** The cursor file in force, or `undefined` when it is absent/corrupt — which restores nothing. */
  cursors: NoticeCursorFile | undefined;
  /** `NoticeQueue`'s per-target bound, so history cannot enter deeper than a live queue may go. */
  maxPerTarget: number;
}

/**
 * Which doorbells go back into which queue.
 *
 * Three bounds, and each one is the answer to a way this could turn a loss into a flood:
 *
 *  1. **Only live agents.** A name with no session cannot be submitted to, and restoring for every
 *     name the trail ever mentioned would grow the map without bound.
 *  2. **Only strictly after the cursor.** `noticeCursorFor` falls back to the workspace baseline, so an
 *     agent that has never had a cursor of its own is measured from the moment the file was
 *     established — never from the beginning of a 3,283-row trail.
 *  3. **Only the newest `maxPerTarget`.** The queue would drop the excess anyway; trimming here means
 *     it does so without emitting an `overflow-drop` witness row for history that was never live.
 */
export function planNoticeReconstitution(input: NoticeReconstitutionInput): NoticeReconstitutionPlan {
  const live = new Set(input.agents);
  const perTarget = new Map<string, ReconstitutedNotice[]>();
  let contentless = 0;
  if (!input.cursors) return { restore: [], contentless: 0 };

  for (const event of input.events) {
    if (!live.has(event.to)) continue;
    const since = noticeCursorFor(input.cursors, event.to);
    if (since !== undefined && event.at <= since) continue;
    const summary = typeof event.summary === "string" ? event.summary.trim() : "";
    if (!summary) {
      contentless += 1;
      continue;
    }
    const createdAt = Date.parse(event.at);
    if (Number.isNaN(createdAt)) {
      // An unparseable `at` cannot be aged, ordered against a cursor, or marked delayed. Treated like
      // a damaged append (`readDoorbellTrailEvents` already swallows those): skipped, never guessed.
      contentless += 1;
      continue;
    }
    const list = perTarget.get(event.to) ?? [];
    list.push({
      target: event.to,
      line: composeBoundedAgentNotice(event.from, event.to, summary, event.pointer),
      from: event.from,
      at: event.at,
      createdAt,
    });
    perTarget.set(event.to, list);
  }

  const restore: ReconstitutedNotice[] = [];
  for (const list of perTarget.values()) {
    list.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
    restore.push(...list.slice(-Math.max(1, input.maxPerTarget)));
  }
  // Oldest first across the whole plan, so the enqueue order matches the order the notices rang.
  restore.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  return { restore, contentless };
}

/** The newest `at` in the trail — the seed for a first-boot baseline. `undefined` for an empty trail. */
export function doorbellTrailTail(events: readonly DoorbellEvent[]): string | undefined {
  let tail: string | undefined;
  for (const event of events) {
    if (tail === undefined || event.at > tail) tail = event.at;
  }
  return tail;
}
