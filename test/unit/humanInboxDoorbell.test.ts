import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  routeHumanApprovalRequest,
  routeHumanInboxItem,
  routeHumanValidationPending,
  routeSavedAgentProposal,
} from "../../src/engine-service/engineService.js";
import { HUMAN_INBOX_KINDS } from "../../src/humanInbox/model.js";

/**
 * t-8e9b5e — every Human Inbox kind rings a doorbell.
 *
 * A Saved Agent proposal was a first-class Inbox item (`HUMAN_INBOX_KINDS` has listed it alongside
 * approval and validation) that notified nobody. Measured on 2026-07-31: two proposals recorded
 * minutes apart, both valid, and the human's report was "nao gerou attention". Proposals expire in
 * 24h, so one nobody saw did not wait — it died, with the proposer still waiting.
 *
 * The shape is t-b4a799's: two paths to the same product effect ("a human must decide something"),
 * one of them missing. So these tests hold the SHARED door, not three copies of one assertion.
 */
function recordingHost(options: { failWith?: Error } = {}) {
  const notices: Array<{ message: string; level?: string; actions: Array<{ label: string; run: () => Promise<void> }> }> = [];
  const commands: Array<[string, ...unknown[]]> = [];
  return {
    notices,
    commands,
    host: {
      t: (template: string, ...args: unknown[]) =>
        template.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? "")),
      notify: (message: string, level?: string, actions?: Array<{ label: string; run: () => Promise<void> }>) => {
        notices.push({ message, level, actions: actions ?? [] });
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        commands.push([command, ...args]);
        if (options.failWith) throw options.failWith;
      },
    },
  };
}

describe("t-8e9b5e — a proposal rings the same doorbell an approval does", () => {
  it("notifies, naming the agent and who proposed it", () => {
    const { host, notices } = recordingHost();

    routeSavedAgentProposal(host, "b349073a", { id: "sp-1a7303", name: "claude-validador", proposer: "claude" });

    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("sp-1a7303");
    expect(notices[0].message).toContain("claude-validador");
    expect(notices[0].message).toContain("claude");
  });

  it("takes Review to that proposal in the Human Inbox, not to the queue's top", () => {
    // Landing on the list would make the person hunt for the item they were just told about.
    const { host, notices, commands } = recordingHost();

    routeSavedAgentProposal(host, "b349073a", { id: "sp-1a7303", name: "x", proposer: "claude" });
    void notices[0].actions[0].run();

    expect(commands[0]).toEqual([
      "tachyon.openHumanInbox",
      "b349073a",
      { kind: "saved-agent-proposal", id: "sp-1a7303" },
    ]);
  });

  it("keeps approval on the Approvals section, which is a real difference and not a leftover", () => {
    const { host, notices, commands } = recordingHost();

    routeHumanApprovalRequest(host, "b349073a", { id: "a-3c5de6", requester: "codex" });
    void notices[0].actions[0].run();

    expect(commands[0]).toEqual(["tachyon.openApprovals", "b349073a"]);
  });

  it("keeps validation pointed at its own Inbox item", () => {
    const { host, notices, commands } = recordingHost();

    routeHumanValidationPending(host, "b349073a", { id: "v-1", title: "t", author: "claude" });
    void notices[0].actions[0].run();

    expect(commands[0]).toEqual(["tachyon.openHumanInbox", "b349073a", { kind: "validation", id: "v-1" }]);
  });

  it("rings for EVERY declared kind — the assertion the defect needed and nobody had", () => {
    // The bug was not a wrong destination; it was a kind nobody enumerated. This iterates the
    // authority (`HUMAN_INBOX_KINDS`) rather than a list written out here, so a fourth kind is
    // covered the moment it is declared instead of when someone remembers to add a case.
    for (const kind of HUMAN_INBOX_KINDS) {
      const { host, notices, commands } = recordingHost();

      routeHumanInboxItem(host, "b349073a", { kind, id: `id-${kind}`, message: `${kind} needs you` });

      expect(notices, `${kind} raised no notice`).toHaveLength(1);
      expect(notices[0].actions[0].label, `${kind} offered no Review`).toBe("Review");
      void notices[0].actions[0].run();
      expect(commands[0]?.[0], `${kind} opened nothing`).toMatch(/^tachyon\./);
    }
  });
});

/**
 * t-5ca73a — what the human is told when Review cannot open its window.
 *
 * Invoking dismisses the notice before the action runs. So a Review that fails silently costs the
 * person the only pointer they had: the attention disappears, nothing opens, and the sole trace is an
 * `ui-unavailable` line in the engine journal that nobody reads. That silence is what made this defect
 * expensive — the deadlock behind it took hours to localize precisely because the UI said nothing.
 */
describe("t-5ca73a — a Review that cannot open says so", () => {
  it("raises an error notice naming the command AND where the item still is", () => {
    const { host, notices } = recordingHost({ failWith: new Error("editor UI operation timed out") });

    routeSavedAgentProposal(host, "b349073a", { id: "sp-4ea3d2", name: "grok-probe", proposer: "claude" });
    // The action rethrows so the caller's own failure path still sees it; the human-facing part is the
    // notice, and it must exist regardless.
    void notices[0].actions[0].run().catch(() => undefined);

    return Promise.resolve().then(() => {
      const failure = notices.find((notice) => notice.level === "error");
      expect(failure, "a failed Review told the human nothing").toBeDefined();
      expect(failure!.message).toContain("tachyon.openHumanInbox");
      // Naming the item is the load-bearing half: the notice that carried it is already gone.
      expect(failure!.message).toContain("sp-4ea3d2");
      expect(failure!.message).toContain("saved-agent-proposal");
    });
  });

  it("stays silent when the window opens, which is the overwhelmingly common case", () => {
    const { host, notices } = recordingHost();

    routeHumanApprovalRequest(host, "b349073a", { id: "a-3c5de6", requester: "codex" });
    void notices[0].actions[0].run();

    return Promise.resolve().then(() => {
      expect(notices.filter((notice) => notice.level === "error")).toHaveLength(0);
    });
  });
});

/**
 * t-8e9b5e — the routing table is exhaustive by TYPE, so a fourth kind cannot compile without a
 * destination. This asserts the table stays a `Record<HumanInboxKind, …>`: rewritten as a partial map
 * or a switch with a default, a new kind would silently fall back to whatever the default is, which
 * is how this defect existed in the first place.
 */
describe("t-8e9b5e — a new Inbox kind cannot be added without a doorbell", () => {
  it("keys the routing table on HumanInboxKind itself", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/engine-service/engineService.ts"), "utf8");

    expect(source).toContain("const INBOX_REVIEW_TARGET: Record<HumanInboxKind,");
    expect(source).not.toMatch(/INBOX_REVIEW_TARGET:\s*Partial</);
  });
});
