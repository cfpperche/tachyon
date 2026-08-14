/**
 * t-8d190f — `submit-unconfirmed` is a THIRD outcome, distinct from both. The line was typed and Enter
 * was pressed, but Tachyon never observed it leave the composer, so it may be sitting staged in the
 * recipient's editor. It is not `notified` (nothing is proven delivered) and not `queued` (nothing is
 * held for a later flush); reporting either would be the bug this task fixes.
 */
export type NoticeDeliveryResult = {
  status: "notified" | "queued" | "submit-unconfirmed";
  dropped?: number;
  queued?: number;
  /** t-44ae02 — createdAt of the oldest item still waiting for this target. Feeds the queued receipt. */
  oldestCreatedAt?: number;
  /** Why confirmation failed, propagated from the tmux submit receipt. */
  submitReason?: string;
  /**
   * t-a53dd9 — set when the wait is on a HUMAN, not on the recipient's turn. A queue held because the
   * recipient is mid-turn ends by itself in seconds; one held because a person is typing into that
   * pane ends when they submit, or at the TTL with the loss reported to them. The sender is told
   * which, because "queued" alone is what makes a doorbell that never lands look like one that did.
   */
  heldFor?: "human-draft";
};
