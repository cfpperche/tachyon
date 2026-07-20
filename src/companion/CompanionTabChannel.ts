/**
 * Companion tab command channel (SDD 414 / t-2a7010 + t-fbe280).
 * Agent tools enqueue snapshot/act requests; the browser extension fulfills them
 * over SSE (tab.command) + POST /companion/v1/tab/result.
 */

import { randomBytes } from "node:crypto";
import type { CompanionTabCommand, CompanionTabResult } from "./protocol.js";

export type TabChannelPush = (event: string, data: unknown) => void;

export interface CompanionTabChannelOptions {
  /** Fan-out to paired extension SSE clients. */
  push: TabChannelPush;
  /** Default wait for extension fulfillment. */
  defaultTimeoutMs?: number;
  now?: () => number;
}

type CommandBody =
  | { kind: "snapshot" }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string; submit?: boolean }
  | { kind: "fill"; selector: string; value: string };

interface Pending {
  command: CompanionTabCommand;
  resolve: (result: CompanionTabResult) => void;
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

  /** Generic enqueue (snapshot | click | type | fill). */
  request(body: CommandBody, timeoutMs?: number): Promise<CompanionTabResult> {
    const id = newId();
    const command = {
      ...body,
      id,
      at: new Date(this.now()).toISOString(),
    } as CompanionTabCommand;
    const ms = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<CompanionTabResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          id,
          code: "timeout",
          message:
            "Companion extension did not fulfill the tab command in time. " +
            "Ensure Companion is paired, live sync is connected, and agent tab access is enabled.",
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

  requestSnapshot(timeoutMs?: number): Promise<CompanionTabResult> {
    return this.request({ kind: "snapshot" }, timeoutMs);
  }

  requestClick(selector: string, timeoutMs?: number): Promise<CompanionTabResult> {
    return this.request({ kind: "click", selector }, timeoutMs);
  }

  requestType(
    selector: string,
    text: string,
    opts?: { submit?: boolean; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    return this.request(
      { kind: "type", selector, text, submit: opts?.submit },
      opts?.timeoutMs,
    );
  }

  requestFill(selector: string, value: string, timeoutMs?: number): Promise<CompanionTabResult> {
    return this.request({ kind: "fill", selector, value }, timeoutMs);
  }

  /** Extension fulfillment (or deny). */
  submitResult(body: CompanionTabResult): { ok: true } | { ok: false; code: "not_found"; message: string } {
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
