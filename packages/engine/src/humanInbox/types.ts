export const HUMAN_INBOX_KINDS = ["approval", "saved-agent-proposal", "saved-agent-removal", "schedule-proposal", "validation"] as const;

export type HumanInboxKind = (typeof HUMAN_INBOX_KINDS)[number];


/**
 * t-e4f662 — how long a row may wait before it is MARKED stale, or `"never"`.
 *
 * `"never"` is a real answer, not a disabled feature: a fleet that parks approvals for days on
 * purpose would see every row marked, and a mark that is always on has stopped being a signal. It is
 * spelled as a word rather than as `0` because `0` reads literally as "stale after zero hours" — the
 * OPPOSITE of off — and this loader refuses ambiguity rather than picking the friendlier reading.
 */
export type StaleAfter = number | "never";
