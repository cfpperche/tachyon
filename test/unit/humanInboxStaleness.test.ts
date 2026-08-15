import { describe, expect, it } from "vitest";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { DEFAULT_STALE_AFTER_HOURS, buildHumanInbox, humanInboxCounts } from "@tachyon/webview-ui/humanInbox/model";
import { buildHumanInboxViewModel } from "../../apps/vscode-extension/src/webview/human-inbox/viewModel.js";
import type { ApprovalViewItem } from "@tachyon/webview-ui/webview/approval/viewModel.js";

/**
 * t-e4f662 — the Human Inbox's staleness threshold, configured rather than hardcoded.
 *
 * The ratified criterion reads "given an item older than a CONFIGURED staleness threshold, then it is
 * marked stale". The projection always took the parameter; nothing ever passed one, so every
 * workspace silently got 24h. What is proven here is the whole path — the value a project writes, the
 * refusals it gets when the value cannot mean what it says, and the mark that follows.
 *
 * The mark stays display-only throughout, as ratified: nothing below approves, denies or closes
 * anything, and an auto-denied approval is a security decision no timer should make.
 */
const NOW = "2026-07-28T12:00:00.000Z";
const hoursBefore = (hours: number): string => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

const approval = (id: string, ageHours: number): ApprovalViewItem => ({
  id,
  requester: "codex-canonico",
  session: "tachyon-ws-codex",
  createdAt: hoursBefore(ageHours),
  payload: { reason: "needs a human", proposedAction: "prune", risk: "irreversible", exactPrompt: "may I?" },
  tampered: false,
});

const yaml = (settings: string): string => `agents:\n  worker:\n    cmd: sh\nsettings:\n${settings}`;

describe("the threshold a project writes", () => {
  it("accepts a positive number of hours", () => {
    const parsed = parseConfig(yaml("  humanInbox:\n    staleAfterHours: 72\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.settings.humanInbox?.staleAfterHours).toBe(72);
  });

  it("accepts a fractional threshold — some queues are measured in minutes", () => {
    const parsed = parseConfig(yaml("  humanInbox:\n    staleAfterHours: 0.5\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.settings.humanInbox?.staleAfterHours).toBe(0.5);
  });

  it("accepts every spelling of off this loader already uses elsewhere", () => {
    // `agentMemoryMax` established false/null/"off"/"none"; a person who knows one knows this one.
    for (const written of ["false", "null", '"off"', '"none"', '"never"']) {
      const parsed = parseConfig(yaml(`  humanInbox:\n    staleAfterHours: ${written}\n`));
      expect(parsed.errors, `${written} should be accepted as off`).toEqual([]);
      expect(parsed.config?.settings.humanInbox?.staleAfterHours).toBe("never");
    }
  });

  it("refuses 0 BY NAME, pointing at the spelling that means off", () => {
    // `0` reads literally as "stale the moment it arrives" — the opposite of the off some author
    // means by it. Guessing which they meant is exactly what this loader does not do.
    const parsed = parseConfig(yaml("  humanInbox:\n    staleAfterHours: 0\n"));
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("settings.humanInbox.staleAfterHours");
    expect(parsed.warnings[0]).toContain("positive number of hours");
    expect(parsed.warnings[0]).toContain("never");
  });

  it("refuses a negative, a non-number and a non-mapping", () => {
    expect(parseConfig(yaml("  humanInbox:\n    staleAfterHours: -1\n")).warnings[0]).toContain("staleAfterHours");
    expect(parseConfig(yaml('  humanInbox:\n    staleAfterHours: "soon"\n')).warnings[0]).toContain("staleAfterHours");
    expect(parseConfig(yaml("  humanInbox: 24\n")).warnings[0]).toContain("settings.humanInbox: must be a mapping");
  });

  it("refuses an unknown key by name rather than ignoring it", () => {
    const parsed = parseConfig(yaml("  humanInbox:\n    staleAfterDays: 2\n"));
    expect(parsed.warnings[0]).toContain("settings.humanInbox: unknown key 'staleAfterDays'");
    expect(parsed.warnings[0]).toContain("allowed: staleAfterHours");
  });

  it("leaves the setting absent when nothing is written", () => {
    const parsed = parseConfig(yaml("  maxAgents: 4\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.settings.humanInbox).toBeUndefined();
  });
});

describe("what the threshold does to the rows", () => {
  const rows = (staleAfterHours?: number | "never") =>
    buildHumanInbox(
      { wsHash: "ws-1", folder: "tachyon", approvals: [approval("a-old", 40), approval("a-new", 2)], validations: [] },
      { now: NOW, ...(staleAfterHours === undefined ? {} : { staleAfterHours }) },
    );

  it("uses the product default when a workspace configures nothing", () => {
    expect(DEFAULT_STALE_AFTER_HOURS).toBe(24);
    const marked = rows().filter((item) => item.stale).map((item) => item.id);
    expect(marked).toEqual(["a-old"]);
  });

  it("honours a longer threshold — the 40h row stops being stale at 48h", () => {
    expect(rows(48).some((item) => item.stale)).toBe(false);
  });

  it("honours a shorter one — the 2h row becomes stale at 1h", () => {
    expect(rows(1).every((item) => item.stale)).toBe(true);
  });

  it("marks nothing at all on 'never', however long anything has waited", () => {
    const items = rows("never");
    expect(items.every((item) => item.stale === false)).toBe(true);
    expect(humanInboxCounts(items).stale).toBe(0);
    // and the rows are still THERE — "never" silences a mark, it does not hide work
    expect(items).toHaveLength(2);
  });

  it("marks and nothing else — no row is resolved, closed or removed by being stale", () => {
    const items = rows(1);
    expect(items.map((item) => item.id).sort()).toEqual(["a-new", "a-old"]);
    expect(items.every((item) => item.detail.kind === "approval")).toBe(true);
  });
});

describe("the view model carries the workspace's own threshold", () => {
  const vm = (staleAfterHours?: number | "never") =>
    buildHumanInboxViewModel({
      folder: "tachyon",
      wsHash: "ws-1",
      approvals: [approval("a-old", 40)],
      validations: [],
      now: NOW,
      ...(staleAfterHours === undefined ? {} : { staleAfterHours }),
    });

  it("defaults when the caller passes none", () => {
    expect(vm().counts.stale).toBe(1);
  });

  it("passes a configured threshold through to the count the surface shows", () => {
    expect(vm(48).counts.stale).toBe(0);
    expect(vm("never").counts.stale).toBe(0);
    expect(vm(1).counts.stale).toBe(1);
  });
});
