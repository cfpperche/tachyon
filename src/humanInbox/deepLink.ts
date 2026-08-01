/**
 * t-d16698 — the RECEIVING half of the Human Inbox doorbell.
 *
 * `routeHumanInboxItem` (engine-service/engineService.ts) decides where "Review" leads, and its
 * `INBOX_REVIEW_TARGET` is a `Record<HumanInboxKind, …>` on purpose: a fourth kind added to
 * `HUMAN_INBOX_KINDS` does not compile until it declares a destination. That guard covers the
 * EMITTER only. The receiver — `tachyon.openHumanInbox` in extension.ts — used to test the incoming
 * kind against three hand-written string literals with no link to the inventory at all:
 *
 *     kind === "validation" || kind === "approval" || kind === "saved-agent-proposal"
 *
 * So a fourth kind would have compiled on the sending side, rung a real doorbell, and then landed
 * the person on the QUEUE instead of the item they were just told about — the exact defect t-8e9b5e
 * closed for the doorbell itself, reappearing one hop later at the door. Two paths to one product
 * effect ("Review opens THIS item") with the guard watching only one of them: t-b4a799's shape.
 *
 * This module is that missing half, derived from `HUMAN_INBOX_KINDS` rather than restating it, so
 * the receiver cannot fall behind the inventory the emitter is already pinned to.
 *
 * It is deliberately SHALLOW beyond the kind. Every field it accepts is re-validated downstream by
 * an authority that owns it (`byHash` decides whether a workspace exists; the cockpit's inbox-item
 * handshake decides whether the item is still pending). Re-deriving those rules here would be a
 * second copy free to disagree with the first — the very thing this file exists to prevent.
 */
import { HUMAN_INBOX_KINDS, type HumanInboxKind } from "./model.js";

/**
 * Where a `tachyon.openHumanInbox` invocation should land.
 *
 * `"list"` is not a failure — an omitted target is the ordinary "open my inbox" palette invocation,
 * and it is also the honest destination for a target this build cannot name.
 */
export type HumanInboxDeepLink =
  | { readonly target: "item"; readonly itemKind: HumanInboxKind; readonly itemId: string }
  | { readonly target: "list" };

export function isHumanInboxKind(value: unknown): value is HumanInboxKind {
  return typeof value === "string" && (HUMAN_INBOX_KINDS as readonly string[]).includes(value);
}

/**
 * Decode the `target` argument of `tachyon.openHumanInbox`.
 *
 * Total over `unknown` because the argument reaches the command from three places with different
 * trust: an in-process notice closure, a `route` restored from `state.json` across a restart
 * (`restoreNoticeInbox`), and the command palette, which passes nothing at all.
 */
export function decodeHumanInboxDeepLink(target: unknown): HumanInboxDeepLink {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return { target: "list" };
  const { kind, id } = target as { kind?: unknown; id?: unknown };
  if (!isHumanInboxKind(kind)) return { target: "list" };
  const itemId = typeof id === "string" ? id.trim() : "";
  if (itemId.length === 0) return { target: "list" };
  return { target: "item", itemKind: kind, itemId };
}
