export interface NoticeQueueItem {
  target: string;
  line: string;
  createdAt: number;
  sourceChild?: string;
  sourceIncarnation?: number;
}

export interface NoticeQueueMetadata {
  sourceChild?: string;
  sourceIncarnation?: number;
}

export interface NoticeQueueOptions {
  maxPerTarget?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface EnqueueResult {
  queued: number;
  dropped: number;
}

export class NoticeQueue {
  private readonly maxPerTarget: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly queues = new Map<string, NoticeQueueItem[]>();

  constructor(options: NoticeQueueOptions = {}) {
    this.maxPerTarget = Math.max(1, Math.floor(options.maxPerTarget ?? 20));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 10 * 60_000));
    this.now = options.now ?? Date.now;
  }

  enqueue(target: string, line: string, metadata: NoticeQueueMetadata = {}): EnqueueResult {
    this.clearExpired(target);
    const queue = this.queues.get(target) ?? [];
    const existing = queue.find((item) => item.line === line);
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

  dequeue(target: string): NoticeQueueItem | undefined {
    this.clearExpired(target);
    const queue = this.queues.get(target);
    if (!queue?.length) return undefined;
    const item = queue.shift();
    if (queue.length === 0) this.queues.delete(target);
    return item;
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

  clearExpired(target?: string): number {
    const now = this.now();
    let dropped = 0;
    const targets = target === undefined ? [...this.queues.keys()] : [target];
    for (const key of targets) {
      const queue = this.queues.get(key);
      if (!queue) continue;
      const fresh = queue.filter((item) => now - item.createdAt <= this.ttlMs);
      dropped += queue.length - fresh.length;
      if (fresh.length > 0) this.queues.set(key, fresh);
      else this.queues.delete(key);
    }
    return dropped;
  }
}
