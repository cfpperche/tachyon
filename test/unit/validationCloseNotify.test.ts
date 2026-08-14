import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeFixedValidationClosedResponse,
  isWakeableAgentName,
  validationCloseWakeRecipients,
  wakeValidationClosedAuthors,
} from "@tachyon/engine/validations/validationCloseNotify.js";
import type { Validation } from "@tachyon/engine/validations/types.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import { legacyBoardTarget } from "../../apps/vscode-extension/src/shell/BoardTarget.js";
import { composeFixedApprovalResponse } from "@tachyon/engine/approvals/approvalRequest.js";
import type { NoticeDeliveryResult } from "@tachyon/engine/bridge/tools.js";

/**
 * t-c6c4ad / t-ebde5f — Validation close must wake the author without inventing an actor.
 *
 * Fail-before: closeRound alone never typed into any session (see BoardTarget /
 * engineService pre-patch). Pass-after: pure compose is FIXED, recipients skip humans, live
 * inject is best-effort and never undoes a durable close.
 */

function sample(partial: Partial<Validation> = {}): Pick<Validation, "id" | "author" | "assignee"> {
  return {
    id: "v-b5e168",
    author: "codex-canonico",
    ...partial,
  };
}

describe("composeFixedValidationClosedResponse", () => {
  it("is a FIXED single-line Tachyon string — id + outcome only, never free-form note bytes", () => {
    const passed = composeFixedValidationClosedResponse(sample(), "passed");
    const failed = composeFixedValidationClosedResponse(sample(), "failed");
    const skipped = composeFixedValidationClosedResponse(sample(), "skipped");
    expect(passed).toBe(
      "[tachyon] validation v-b5e168 closed as passed — you may proceed accordingly",
    );
    expect(failed).toBe(
      "[tachyon] validation v-b5e168 closed as failed — you may proceed accordingly",
    );
    expect(skipped).toBe(
      "[tachyon] validation v-b5e168 closed as skipped — you may proceed accordingly",
    );
    // No caller-supplied prose can leak into the inject (approval twin).
    expect(passed).not.toMatch(/\n|\r/);
    expect(passed.startsWith("[tachyon] ")).toBe(true);
  });
});

describe("validationCloseWakeRecipients", () => {
  it("wakes the author when they are an agent", () => {
    expect(validationCloseWakeRecipients(sample())).toEqual(["codex-canonico"]);
  });

  it("also wakes a distinct live assignee", () => {
    expect(validationCloseWakeRecipients(sample({ assignee: "grok-builder" }))).toEqual([
      "codex-canonico",
      "grok-builder",
    ]);
  });

  it("dedupes when author and assignee are the same agent", () => {
    expect(validationCloseWakeRecipients(sample({ assignee: "codex-canonico" }))).toEqual([
      "codex-canonico",
    ]);
  });

  it("never treats a human/host surface as a recipient", () => {
    expect(validationCloseWakeRecipients(sample({ author: "human" }))).toEqual([]);
    expect(validationCloseWakeRecipients(sample({ author: "vscode", assignee: "human" }))).toEqual([]);
    expect(validationCloseWakeRecipients(sample({ author: "human", assignee: "codex-canonico" }))).toEqual([
      "codex-canonico",
    ]);
  });

  it("rejects names that are not agent-shaped", () => {
    expect(isWakeableAgentName("human")).toBe(false);
    expect(isWakeableAgentName("vscode")).toBe(false);
    expect(isWakeableAgentName("1bad")).toBe(false);
    expect(isWakeableAgentName("codex-canonico")).toBe(true);
    expect(isWakeableAgentName("grok_builder")).toBe(true);
  });
});

describe("wakeValidationClosedAuthors", () => {
  it("injects the FIXED line into each live agent session", async () => {
    const inject = vi.fn(async (session: string) => ({ receipt: `tmux:${session}` }));
    const result = await wakeValidationClosedAuthors({
      validation: sample({ assignee: "reviewer" }),
      outcome: "passed",
      listEntries: async () => [
        { name: "codex-canonico", session: "tachyon-h-codex", running: true, kind: "agent" },
        { name: "reviewer", session: "tachyon-h-reviewer", running: true, kind: "agent" },
        { name: "idle-other", session: "tachyon-h-idle", running: false, kind: "agent" },
      ],
      inject,
    });

    expect(result.injectedText).toBe(composeFixedValidationClosedResponse(sample(), "passed"));
    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenCalledWith("tachyon-h-codex", result.injectedText);
    expect(inject).toHaveBeenCalledWith("tachyon-h-reviewer", result.injectedText);
    expect(result.deliveries).toEqual([
      { agent: "codex-canonico", session: "tachyon-h-codex", receipt: "tmux:tachyon-h-codex" },
      { agent: "reviewer", session: "tachyon-h-reviewer", receipt: "tmux:tachyon-h-reviewer" },
    ]);
  });

  it("does not fail the close when the author is offline — durable result already stands", async () => {
    const inject = vi.fn(async () => ({ receipt: "should-not-run" }));
    const result = await wakeValidationClosedAuthors({
      validation: sample(),
      outcome: "passed",
      listEntries: async () => [
        { name: "codex-canonico", session: "tachyon-h-codex", running: false, kind: "agent" },
      ],
      inject,
    });

    expect(inject).not.toHaveBeenCalled();
    expect(result.deliveries).toEqual([{ agent: "codex-canonico", skipped: "offline" }]);
  });

  it("records inject failure without throwing — the human decision is not rolled back", async () => {
    const inject = vi.fn(async () => {
      throw new Error("tmux pane gone");
    });
    const result = await wakeValidationClosedAuthors({
      validation: sample(),
      outcome: "failed",
      listEntries: async () => [
        { name: "codex-canonico", session: "tachyon-h-codex", running: true, kind: "agent" },
      ],
      inject,
    });

    expect(result.deliveries).toEqual([
      {
        agent: "codex-canonico",
        session: "tachyon-h-codex",
        skipped: "inject-error",
        error: "tmux pane gone",
      },
    ]);
  });

  it("skips terminals and dead/stopping rows", async () => {
    const inject = vi.fn(async (session: string) => ({ receipt: `tmux:${session}` }));
    const result = await wakeValidationClosedAuthors({
      validation: sample({ author: "server", assignee: "codex-canonico" }),
      outcome: "passed",
      listEntries: async () => [
        { name: "server", session: "tachyon-h-server", running: true, kind: "terminal" },
        { name: "codex-canonico", session: "tachyon-h-codex", running: true, kind: "agent", dead: true },
      ],
      inject,
    });

    expect(inject).not.toHaveBeenCalled();
    expect(result.deliveries.every((d) => d.skipped === "offline")).toBe(true);
  });

  it("listEntries failure is offline for everyone, never a thrown error", async () => {
    const result = await wakeValidationClosedAuthors({
      validation: sample(),
      outcome: "passed",
      listEntries: async () => {
        throw new Error("manager unavailable");
      },
      inject: async () => ({ receipt: "nope" }),
    });
    expect(result.deliveries).toEqual([
      { agent: "codex-canonico", skipped: "offline", error: "manager unavailable" },
    ]);
  });

  it("wakes each recipient at most once even if listEntries returns duplicates", async () => {
    const inject = vi.fn(async (session: string) => ({ receipt: `tmux:${session}` }));
    await wakeValidationClosedAuthors({
      validation: sample({ assignee: "codex-canonico" }),
      outcome: "passed",
      listEntries: async () => [
        { name: "codex-canonico", session: "tachyon-h-codex", running: true, kind: "agent" },
        { name: "codex-canonico", session: "tachyon-h-codex-dup", running: true, kind: "agent" },
      ],
      inject,
    });
    // One recipient name → one inject (first live match).
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("tachyon-h-codex", expect.any(String));
  });
});

/**
 * Integration through the shared Board close path used by BOTH Human Inbox and the
 * legacy Validations tab — one call, one wake (no double notify when UIs share the target).
 */
describe("legacyBoardTarget.closeValidation wakes the author once", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists the closed round AND wakes via deliverNotice when the author is live", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vclose-wake-"));
    roots.push(root);
    const store = new ValidationStore(root);
    const created = await store.create({
      title: "dogfood the inbox close wake",
      author: "codex-canonico",
      executor: "human",
    });

    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "notified" }));
    const sendSubmittedLine = vi.fn(async () => {});
    const target = legacyBoardTarget({
      workspaceRoot: root,
      wsHash: "ws-test",
      folderName: "tachyon",
      manager: {
        list: async () => [
          {
            name: "codex-canonico",
            session: "tachyon-h-codex",
            running: true,
            kind: "agent" as const,
            declared: true,
          },
        ],
        listAgents: async () => [],
      },
      taskStore: { reorderLane: async () => {} } as never,
      validationStore: store,
      deliverNotice,
      tmux: { sendSubmittedLine },
    });

    // Single close path (Inbox and legacy Validations both call this once per human action).
    await target.closeValidation(created.id, { outcome: "passed", result_note: "aprovado" });

    const closed = store.get(created.id);
    expect(closed.status).toBe("closed");
    expect(closed.rounds[0]?.outcome).toBe("passed");
    expect(closed.rounds[0]?.result_note).toBe("aprovado");

    // t-b805b5 — agent-addressed notice delivery, not a raw session write.
    expect(deliverNotice).toHaveBeenCalledTimes(1);
    expect(deliverNotice).toHaveBeenCalledWith(
      "codex-canonico",
      composeFixedValidationClosedResponse(created, "passed"),
    );
    expect(sendSubmittedLine).not.toHaveBeenCalled();
  });

  it("queues for a busy author instead of typing a bare submit into their composer", async () => {
    // Twin of t-d79534: mid-turn author must be enqueued; a naked sendSubmittedLine would land in an
    // occupied composer and never start a turn while the durable close already succeeded.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vclose-queued-"));
    roots.push(root);
    const store = new ValidationStore(root);
    const created = await store.create({
      title: "author mid-turn",
      author: "codex-canonico",
      executor: "human",
    });

    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "queued", queued: 1 }));
    const sendSubmittedLine = vi.fn(async () => {});
    const target = legacyBoardTarget({
      workspaceRoot: root,
      wsHash: "ws-test",
      folderName: "tachyon",
      manager: {
        list: async () => [
          {
            name: "codex-canonico",
            session: "tachyon-h-codex",
            running: true,
            kind: "agent" as const,
            declared: true,
          },
        ],
        listAgents: async () => [],
      },
      taskStore: { reorderLane: async () => {} } as never,
      validationStore: store,
      deliverNotice,
      tmux: { sendSubmittedLine },
    });

    await target.closeValidation(created.id, { outcome: "passed", result_note: "ok" });

    expect(store.get(created.id).status).toBe("closed");
    expect(deliverNotice).toHaveBeenCalledTimes(1);
    expect(deliverNotice).toHaveBeenCalledWith(
      "codex-canonico",
      composeFixedValidationClosedResponse(created, "passed"),
    );
    // The queue held the wake — no blind session write.
    expect(sendSubmittedLine).not.toHaveBeenCalled();
  });

  it("still persists the close when the author has no live session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vclose-offline-"));
    roots.push(root);
    const store = new ValidationStore(root);
    const created = await store.create({
      title: "author offline",
      author: "codex-canonico",
      executor: "human",
    });
    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "notified" }));
    const sendSubmittedLine = vi.fn(async () => {});
    const target = legacyBoardTarget({
      workspaceRoot: root,
      wsHash: "ws-test",
      folderName: "tachyon",
      manager: {
        list: async () => [
          { name: "codex-canonico", session: "tachyon-h-codex", running: false, kind: "agent" as const, declared: true },
        ],
        listAgents: async () => [],
      },
      taskStore: { reorderLane: async () => {} } as never,
      validationStore: store,
      deliverNotice,
      tmux: { sendSubmittedLine },
    });

    await target.closeValidation(created.id, { outcome: "failed", result_note: "broke" });
    expect(store.get(created.id).status).toBe("closed");
    expect(deliverNotice).not.toHaveBeenCalled();
    expect(sendSubmittedLine).not.toHaveBeenCalled();
  });

  it("matches approval inject posture: FIXED host line, no invented actor or free-form text", () => {
    // t-ebde5f reproduced the missing fact: a nonce-only control-socket speaker can close a
    // validation without a human gesture. Both host lines therefore carry the durable result without
    // claiming an actor their respective doors cannot prove.
    const approvalLine = composeFixedApprovalResponse(
      { id: "a-d1d7d8" } as never,
      "approved",
    );
    const validationLine = composeFixedValidationClosedResponse({ id: "v-b5e168" }, "passed");
    expect(approvalLine.startsWith("[tachyon] ")).toBe(true);
    expect(approvalLine).toContain("a-d1d7d8");
    expect(approvalLine.startsWith("[tachyon] human ")).toBe(false);
    expect(validationLine.startsWith("[tachyon] human ")).toBe(false);
    expect(validationLine.startsWith("[tachyon] validation ")).toBe(true);
    expect(validationLine).toContain("v-b5e168");
    expect(validationLine).not.toContain("aprovado"); // caller note stays on the durable record
  });
});
