/**
 * Companion tab command channel (SDD 414 / t-2a7010).
 * Agent tools enqueue snapshot requests; the browser extension fulfills them
 * over SSE (tab.command) + POST /companion/v1/tab/result.
 */

import { randomBytes } from "node:crypto";
import type { CompanionTabCommand, CompanionTabSnapshotResult } from "./protocol.js";

export type TabChannelPush = (event: string, data: unknown) => void;

export interface CompanionTabChannelOptions {
  /** Fan-out to paired extension SSE clients. */
  push: TabChannelPush;
  /** Default wait for extension fulfillment. */
  defaultTimeoutMs?: number;
  now?: () => number;
}

interface Pending {
  command: CompanionTabCommand;
  resolve: (result: CompanionTabSnapshotResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

export class CompanionTabChannel {
  private readonly pending = new Map<string, Pending>();
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CompanionTabChannelOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  listPending(): CompanionTabCommand[] {
    return [...this.pending.values()].map((p) => p.command);
  }

  /**
   * Ask the paired Companion extension for a DOM outline of the user's active tab.
   * Resolves when the extension POSTs a result, or times out / offline.
   */
  requestSnapshot(timeoutMs?: number): Promise<CompanionTabSnapshotResult> {
    const id = newId();
    const command: CompanionTabCommand = {
      id,
      kind: "snapshot",
      at: new Date(this.now()).toISOString(),
    };
    const ms = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<CompanionTabSnapshotResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          id,
          code: "timeout",
          message:
            "Companion extension did not fulfill the tab snapshot in time. " +
            "Ensure Companion is paired, live sync is connected, and agent tab reads are enabled.",
        });
      }, ms);
      timer.unref?.();

      this.pending.set(id, { command, resolve, timer });
      try {
        this.options.push("tab.command", command);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          ok: false,
          id,
          code: "offline",
          message: "No Companion live stream to deliver tab.command (extension not connected).",
        });
      }
    });
  }

  /** Extension fulfillment (or deny). */
  submitResult(body: CompanionTabSnapshotResult): { ok: true } | { ok: false; code: "not_found"; message: string } {
    const id = body.id;
    if (!id || typeof id !== "string") {
      return { ok: false, code: "not_found", message: "Missing result id." };
    }
    const p = this.pending.get(id);
    if (!p) {
      return { ok: false, code: "not_found", message: `No pending tab command '${id}'.` };
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(body);
    return { ok: true };
  }

  /** Drop all waiters (unpair / teardown). */
  closeAll(reason = "Companion tab channel closed."): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, id, code: "offline", message: reason });
      this.pending.delete(id);
    }
  }
}
