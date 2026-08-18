export type NoticeOrigin = "host-poke" | "agent-authored";

/**
 * t-b47fb2 — the witness timestamp (`DoorbellEvent.at`) of the `notify_agent` this notice carries.
 *
 * Present only for notices that HAVE a durable witness row, which is exactly the `notify_agent`
 * doorbells: a host poke or an approval-resolution line never touches `doorbells.jsonl` and therefore
 * has no position for a cursor to name. It travels on the queue item so the moment of DELIVERY can
 * advance `.tachyon/notice-cursors.json` — without it, an engine restart cannot tell an undelivered
 * doorbell from one the recipient already read, and reconstitution becomes a flood.
 */
export interface WitnessedNoticeMetadata {
  doorbellAt?: string;
}

export interface ChildBoundNoticeMetadata extends WitnessedNoticeMetadata {
  origin: NoticeOrigin;
  sourceChild: string;
  sourceIncarnation?: number;
}

export interface UnboundNoticeMetadata extends WitnessedNoticeMetadata {
  origin?: undefined;
  sourceChild?: undefined;
  sourceIncarnation?: undefined;
}

export type NoticeQueueMetadata = ChildBoundNoticeMetadata | UnboundNoticeMetadata;
