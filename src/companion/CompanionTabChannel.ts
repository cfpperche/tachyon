/**
 * Companion tab command channel (SDD 414 + SDD 420 foundation).
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

export type TabTarget = {
  tabId: string;
  expectedDocumentToken?: string;
};

type CommandBody =
  | { kind: "tabs_list" }
  | ({ kind: "snapshot" } & TabTarget)
  | ({
      kind: "screenshot";
      format?: "jpeg" | "png";
      quality?: number;
      scope?: "viewport" | "full_page" | "element";
      ref?: string;
      selector?: string;
    } & TabTarget)
  | ({ kind: "click"; ref?: string; selector?: string } & TabTarget)
  | ({ kind: "type"; ref?: string; selector?: string; text: string; submit?: boolean } & TabTarget)
  | ({ kind: "fill"; ref?: string; selector?: string; value: string } & TabTarget)
  | ({ kind: "eval"; expression: string } & TabTarget)
  | ({ kind: "console"; limit?: number } & TabTarget)
  | ({
      kind: "navigate";
      action: "goto" | "back" | "forward" | "reload";
      url?: string;
    } & TabTarget)
  | ({
      kind: "scroll";
      direction?: "up" | "down" | "left" | "right";
      pixels?: number;
      ref?: string;
      selector?: string;
    } & TabTarget)
  | ({
      kind: "press_key";
      key: string;
      modifiers?: string[];
      ref?: string;
      selector?: string;
    } & TabTarget)
  | ({
      kind: "wait_for";
      what: "element" | "text" | "navigation" | "load";
      ref?: string;
      selector?: string;
      text?: string;
      timeoutMs?: number;
    } & TabTarget)
  | { kind: "tab_open"; url?: string; active?: boolean }
  | ({ kind: "tab_activate" } & TabTarget)
  | ({ kind: "tab_close" } & TabTarget)
  | ({
      kind: "get";
      what: "text" | "html" | "value" | "attribute" | "state";
      attribute?: string;
      ref?: string;
      selector?: string;
    } & TabTarget)
  | ({ kind: "find"; text: string; limit?: number } & TabTarget)
  | ({ kind: "hover"; ref?: string; selector?: string } & TabTarget)
  | ({
      kind: "select_option";
      ref?: string;
      selector?: string;
      value?: string;
      label?: string;
      index?: number;
    } & TabTarget)
  | ({ kind: "check"; ref?: string; selector?: string; checked: boolean } & TabTarget);

interface Pending {
  command: CompanionTabCommand;
  resolve: (result: CompanionTabResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

function requireTarget(target: TabTarget): void {
  if (!target.tabId?.trim()) {
    throw new Error("tabId is required (SDD 420 — no active-tab default).");
  }
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

  /** Generic enqueue (tabs_list | snapshot | screenshot | act | eval | console). */
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
          tabId: "tabId" in body ? body.tabId : undefined,
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
          tabId: "tabId" in body ? body.tabId : undefined,
        });
      }
    });
  }

  requestTabsList(timeoutMs?: number): Promise<CompanionTabResult> {
    return this.request({ kind: "tabs_list" }, timeoutMs);
  }

  requestSnapshot(target: TabTarget, timeoutMs?: number): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request({ kind: "snapshot", ...target }, timeoutMs);
  }

  requestScreenshot(
    target: TabTarget,
    opts?: {
      format?: "jpeg" | "png";
      quality?: number;
      scope?: "viewport" | "full_page" | "element";
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      {
        kind: "screenshot",
        ...target,
        format: opts?.format,
        quality: opts?.quality,
        scope: opts?.scope,
        ref: opts?.ref,
        selector: opts?.selector,
      },
      opts?.timeoutMs,
    );
  }

  requestEval(target: TabTarget, expression: string, timeoutMs?: number): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request({ kind: "eval", ...target, expression }, timeoutMs);
  }

  requestConsole(target: TabTarget, limit?: number, timeoutMs?: number): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request({ kind: "console", ...target, limit }, timeoutMs);
  }

  requestClick(
    target: TabTarget,
    opts: { ref?: string; selector?: string; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      { kind: "click", ...target, ref: opts.ref, selector: opts.selector },
      opts.timeoutMs,
    );
  }

  requestType(
    target: TabTarget,
    opts: { ref?: string; selector?: string; text: string; submit?: boolean; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      {
        kind: "type",
        ...target,
        ref: opts.ref,
        selector: opts.selector,
        text: opts.text,
        submit: opts.submit,
      },
      opts.timeoutMs,
    );
  }

  requestFill(
    target: TabTarget,
    opts: { ref?: string; selector?: string; value: string; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      {
        kind: "fill",
        ...target,
        ref: opts.ref,
        selector: opts.selector,
        value: opts.value,
      },
      opts.timeoutMs,
    );
  }


  requestNavigate(
    target: TabTarget,
    action: "goto" | "back" | "forward" | "reload",
    opts?: { url?: string; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      { kind: "navigate", ...target, action, url: opts?.url },
      opts?.timeoutMs,
    );
  }

  requestScroll(
    target: TabTarget,
    opts: {
      direction?: "up" | "down" | "left" | "right";
      pixels?: number;
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      {
        kind: "scroll",
        ...target,
        direction: opts.direction,
        pixels: opts.pixels,
        ref: opts.ref,
        selector: opts.selector,
      },
      opts.timeoutMs,
    );
  }

  requestPressKey(
    target: TabTarget,
    opts: {
      key: string;
      modifiers?: string[];
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      {
        kind: "press_key",
        ...target,
        key: opts.key,
        modifiers: opts.modifiers,
        ref: opts.ref,
        selector: opts.selector,
      },
      opts.timeoutMs,
    );
  }

  requestWaitFor(
    target: TabTarget,
    opts: {
      what: "element" | "text" | "navigation" | "load";
      ref?: string;
      selector?: string;
      text?: string;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      {
        kind: "wait_for",
        ...target,
        what: opts.what,
        ref: opts.ref,
        selector: opts.selector,
        text: opts.text,
        timeoutMs: opts.timeoutMs,
      },
      opts.timeoutMs,
    );
  }

  requestTabOpen(opts?: { url?: string; active?: boolean; timeoutMs?: number }): Promise<CompanionTabResult> {
    return this.request({ kind: "tab_open", url: opts?.url, active: opts?.active }, opts?.timeoutMs);
  }

  requestTabActivate(target: TabTarget, timeoutMs?: number): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request({ kind: "tab_activate", ...target }, timeoutMs);
  }

  requestTabClose(target: TabTarget, timeoutMs?: number): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request({ kind: "tab_close", ...target }, timeoutMs);
  }

  requestGet(
    target: TabTarget,
    opts: {
      what: "text" | "html" | "value" | "attribute" | "state";
      attribute?: string;
      ref?: string;
      selector?: string;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      {
        kind: "get",
        ...target,
        what: opts.what,
        attribute: opts.attribute,
        ref: opts.ref,
        selector: opts.selector,
      },
      opts.timeoutMs,
    );
  }

  requestFind(
    target: TabTarget,
    opts: { text: string; limit?: number; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    return this.request(
      { kind: "find", ...target, text: opts.text, limit: opts.limit },
      opts.timeoutMs,
    );
  }

  requestHover(
    target: TabTarget,
    opts: { ref?: string; selector?: string; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      { kind: "hover", ...target, ref: opts.ref, selector: opts.selector },
      opts.timeoutMs,
    );
  }

  requestSelectOption(
    target: TabTarget,
    opts: {
      ref?: string;
      selector?: string;
      value?: string;
      label?: string;
      index?: number;
      timeoutMs?: number;
    },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      {
        kind: "select_option",
        ...target,
        ref: opts.ref,
        selector: opts.selector,
        value: opts.value,
        label: opts.label,
        index: opts.index,
      },
      opts.timeoutMs,
    );
  }

  requestCheck(
    target: TabTarget,
    opts: { ref?: string; selector?: string; checked: boolean; timeoutMs?: number },
  ): Promise<CompanionTabResult> {
    requireTarget(target);
    if (!opts.ref?.trim() && !opts.selector?.trim()) {
      return Promise.resolve({
        ok: false,
        id: "local",
        code: "not_found",
        message: "Provide ref (preferred) or selector.",
        tabId: target.tabId,
      });
    }
    return this.request(
      {
        kind: "check",
        ...target,
        ref: opts.ref,
        selector: opts.selector,
        checked: opts.checked,
      },
      opts.timeoutMs,
    );
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
