/**
 * t-fb1453 — WHY a queued notice names a child decides whether it survives that child.
 *
 * `host-poke` is Tachyon speaking ABOUT a child: "child 'X' is waiting for input", "child 'X' exited",
 * "child 'X' is rate-limited". Every one of them is a claim about a LIVE state, and a claim about a
 * live state stops being true the moment the child stops existing — delivering one into the parent's
 * pane afterwards is the dead child reaching out from beyond the grave (t-572cef/t-eed531).
 *
 * `agent-authored` is the child speaking FOR ITSELF: the `notify_agent` completion doorbell. It reports
 * something that already happened, and a finished report does not become false because its author has
 * since been dismissed. Measured on 2026-08-01: a coordinator killed `codex-revisor` minutes after it
 * rang, and the kill destroyed the queued report the kill was a response to.
 */
export type NoticeOrigin = "host-poke" | "agent-authored";

export const DEFAULT_NOTICE_TTL_MS = 10 * 60_000;

/**
 * A notice bound to one child's identity. `origin` is REQUIRED, and deliberately not defaultable: a
 * caller that binds a notice to a child must state whether the notice's truth expires with that child,
 * because there is no answer that is safe to guess. Guessing "host-poke" loses completion reports;
 * guessing "agent-authored" resurrects dead-child pokes.
 */
export interface ChildBoundNoticeMetadata {
  origin: NoticeOrigin;
  sourceChild: string;
  sourceIncarnation?: number;
}

/** A notice that names no child (approval relays, task-assignee wakeups): never incarnation-filtered. */
export interface UnboundNoticeMetadata {
  origin?: undefined;
  sourceChild?: undefined;
  sourceIncarnation?: undefined;
}

/**
 * The union is the enforcement. `{}` still type-checks (an unbound relay), but `{ sourceChild: "x" }`
 * does NOT — the compiler demands the origin from anyone who reaches for a child's identity.
 */
export type NoticeQueueMetadata = ChildBoundNoticeMetadata | UnboundNoticeMetadata;

export interface NoticeQueueItem {
  target: string;
  line: string;
  createdAt: number;
  origin?: NoticeOrigin;
  sourceChild?: string;
  sourceIncarnation?: number;
}

export interface NoticeQueueOptions {
  maxPerTarget?: number;
  ttlMs?: number;
  now?: () => number;
  /**
   * t-fb1453 — expiry used to be the one drop path that told nobody. Overflow already warns the human
   * (`Workspace.enqueueNotice`); a doorbell quietly eaten by the TTL is the strictly worse loss, because
   * the sender was told `queued … for idle delivery` and nothing ever contradicts it. Fired for every
   * item the TTL removes, from whichever operation happened to trigger the sweep.
   */
  onExpired?: (items: NoticeQueueItem[]) => void;
}

export interface EnqueueResult {
  queued: number;
  dropped: number;
}

export class NoticeQueue {
  private readonly maxPerTarget: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onExpired?: (items: NoticeQueueItem[]) => void;
  private readonly queues = new Map<string, NoticeQueueItem[]>();

  constructor(options: NoticeQueueOptions = {}) {
    this.maxPerTarget = Math.max(1, Math.floor(options.maxPerTarget ?? 20));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_NOTICE_TTL_MS));
    this.now = options.now ?? Date.now;
    this.onExpired = options.onExpired;
  }

  enqueue(target: string, line: string, metadata: NoticeQueueMetadata = {}): EnqueueResult {
    this.clearExpired(target);
    const queue = this.queues.get(target) ?? [];
    // t-572cef: never merge across origins — a metadata-bearing child poke and a metadata-free
    // relay must not collapse into one slot even on exact text match (both undefined counts as same).
    // t-fb1453 extends the same rule to WHY the notice names the child: a host poke and an authored
    // doorbell with identical text have different survival rules, so they cannot share a slot.
    const existing = queue.find(
      (item) => item.line === line && item.sourceChild === metadata.sourceChild && item.origin === metadata.origin,
    );
    if (existing) {
      if (metadata.sourceChild !== undefined) existing.sourceChild = metadata.sourceChild;
      if (metadata.sourceIncarnation !== undefined) existing.sourceIncarnation = metadata.sourceIncarnation;
      return { queued: queue.length, dropped: 0 };
    }
    queue.push({ target, line, createdAt: this.now(), ...metadata });
    let dropped = 0;
    while (queue.length > this.maxPerTarget) {
      queue.shift();
      dropped += 1;
    }
    if (queue.length > 0) this.queues.set(target, queue);
    else this.queues.delete(target);
    return { queued: queue.length, dropped };
  }

  /**
   * t-fb1453 — read the head WITHOUT consuming it, so a submit whose outcome could not be observed
   * leaves the notice where it can still be retried. `dequeue`'s remove-then-submit was the same
   * unknown-flattened-into-known shape the board catalogues as t-b4a799: the item was gone before
   * anyone knew whether it had landed.
   */
  peek(target: string): NoticeQueueItem | undefined {
    this.clearExpired(target);
    return this.queues.get(target)?.[0];
  }

  /** Remove the head — called only once its fate is KNOWN (delivered, or deliberately discarded). */
  dropFront(target: string): NoticeQueueItem | undefined {
    const queue = this.queues.get(target);
    if (!queue?.length) return undefined;
    const item = queue.shift();
    if (queue.length === 0) this.queues.delete(target);
    return item;
  }

  dequeue(target: string): NoticeQueueItem | undefined {
    this.clearExpired(target);
    return this.dropFront(target);
  }

  count(target: string): number {
    this.clearExpired(target);
    return this.queues.get(target)?.length ?? 0;
  }

  clear(target: string): number {
    const count = this.queues.get(target)?.length ?? 0;
    this.queues.delete(target);
    return count;
  }

  /** Returns the items the TTL removed (also handed to `onExpired`), newest-first order preserved. */
  clearExpired(target?: string): NoticeQueueItem[] {
    const now = this.now();
    const expired: NoticeQueueItem[] = [];
    const targets = target === undefined ? [...this.queues.keys()] : [target];
    for (const key of targets) {
      const queue = this.queues.get(key);
      if (!queue) continue;
      const fresh: NoticeQueueItem[] = [];
      for (const item of queue) {
        // t-93bec9 — an authored doorbell reports history, so elapsed time cannot make it false.
        // It remains bounded by maxPerTarget; host pokes and unbound relays retain the TTL because
        // they describe live state or are ordinary transient notifications.
        if (item.origin === "agent-authored" || now - item.createdAt <= this.ttlMs) fresh.push(item);
        else expired.push(item);
      }
      if (fresh.length > 0) this.queues.set(key, fresh);
      else this.queues.delete(key);
    }
    if (expired.length > 0) this.onExpired?.(expired);
    return expired;
  }
}
