import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "@tachyon/bridge/tools.js";
import {
  ProposalStore,
  SCHEDULE_PROPOSAL_PENDING_CEILING,
  SCHEDULE_PROPOSAL_TTL_MS,
} from "@tachyon/engine/schedule/ProposalStore.js";
import { buildHumanInbox } from "@tachyon/webview-ui/humanInbox/model";
import type { CallerSnapshot } from "@tachyon/bridge/callerIdentity.js";

/** A fake MCP server that just captures tool handlers (same shape probeBridge.test.ts uses). */
class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bridge(caller: CallerSnapshot | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-author-"));
  roots.push(root);
  const proposals = new ProposalStore(root);
  if (caller?.kind === "agent" && caller.name) {
    const dir = path.join(root, ".tachyon", "agents", caller.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.yml"), "schemaVersion: 1\nagentId: 123e4567-e89b-42d3-a456-426614174000\nruntime:\n  adapter: claude\n  executable: claude\n");
  }
  const toasts: Array<{ name: string; by: string }> = [];
  const mcp = new FakeMcp();
  const deps = {
    manager: undefined as never,
    tmux: undefined as never,
    pins: undefined as never,
    notify: () => {},
    workspaceRoot: root,
    proposals,
    onScheduleProposed: ({ name, by }) => { toasts.push({ name, by }); },
    ...(caller ? { caller } : {}),
  } satisfies Partial<BridgeDeps> as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  const propose = async (name: string) => {
    const handler = mcp.handlers.get("propose_schedule");
    if (!handler) throw new Error("propose_schedule is not registered");
    return handler({ name, every: "1h", run: "test", reason: "nightly regression" });
  };
  return { root, proposals, toasts, propose };
}

/**
 * t-d4f246 — the non-agent case below was briefly rewritten to assert a REFUSAL, because a capability
 * gate added in the same commit made non-agents fail. Both were reverted. The contract this file has
 * always held is narrower and different: a non-agent MAY propose, and what must never happen is its
 * author reading as an agent name. Rewriting the assertion to match the new behaviour removed the one
 * guard that would have reported the contract change.
 */
describe("who proposed a schedule (t-fbefec)", () => {
  it("records the agent the Bridge resolved, not a placeholder", async () => {
    const { proposals, toasts, propose } = bridge({ kind: "agent", name: "codex-canonico" });
    const result = await propose("nightly");
    expect(result.isError, result.content[0]?.text).not.toBe(true);

    expect(proposals.list()).toMatchObject([{ name: "nightly", by: "codex-canonico", reason: "nightly regression" }]);
    // The human's toast names the same proposer the record does.
    expect(toasts).toEqual([{ name: "nightly", by: "codex-canonico" }]);
  });

  it("does not dress a non-agent caller up as an agent", async () => {
    for (const [caller, expected] of [
      [{ kind: "legacy" } as CallerSnapshot, "(legacy)"],
      [{ kind: "external" } as CallerSnapshot, "(external)"],
      [{ kind: "human" } as CallerSnapshot, "(human)"],
      [undefined, "(legacy)"],
    ] as const) {
      const { proposals, propose } = bridge(caller);
      await propose("nightly");
      expect(proposals.list()[0]?.by).toBe(expected);
      // Parentheses are outside the agent-name alphabet, so this can never read as one.
      expect(proposals.list()[0]?.by).not.toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    }
  });

  it("takes no author from the arguments — nobody proposes in someone else's name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-author-"));
    roots.push(root);
    const proposals = new ProposalStore(root);
    const dir = path.join(root, ".tachyon", "agents", "claude-opus5-3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.yml"), "schemaVersion: 1\nagentId: 123e4567-e89b-42d3-a456-426614174000\nruntime:\n  adapter: claude\n  executable: claude\n");
    const mcp = new FakeMcp();
    registerTools(mcp as never, {
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      notify: () => {},
      workspaceRoot: root,
      proposals,
      caller: { kind: "agent", name: "claude-opus5-3" },
    } satisfies Partial<BridgeDeps> as unknown as BridgeDeps);

    // Author-looking arguments are not part of the tool's input and must not reach the record.
    const result = await mcp.handlers.get("propose_schedule")!({
      name: "nightly", every: "1h", run: "test",
      by: "codex-canonico", agent: "codex-canonico", author: "codex-canonico", requester: "codex-canonico",
    });
    expect(result.isError, result.content[0]?.text).not.toBe(true);

    expect(proposals.list()[0]?.by).toBe("claude-opus5-3");
  });
});

describe("schedule proposal volume ceiling (t-e5ecec)", () => {
  it("limits only this proposer's live pending work and reports both usage and limit", async () => {
    const mine = bridge({ kind: "agent", name: "codex-canonico" });
    for (let index = 0; index < SCHEDULE_PROPOSAL_PENDING_CEILING; index += 1) {
      const accepted = await mine.propose(`mine-${index}`);
      expect(accepted.isError, accepted.content[0]?.text).not.toBe(true);
    }

    const refused = await mine.propose("one-too-many");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain(
      `already has ${SCHEDULE_PROPOSAL_PENDING_CEILING} pending schedule proposals`,
    );
    expect(refused.content[0]?.text).toContain(`ceiling ${SCHEDULE_PROPOSAL_PENDING_CEILING}`);

    // A neighbour's queue is independent, and resolving one of mine immediately frees its slot.
    const neighbour = new ProposalStore(mine.root);
    expect(() => neighbour.create("theirs", { every: "1h", run: "test" }, "claude-runtime")).not.toThrow();
    mine.proposals.remove(mine.proposals.list().find((proposal) => proposal.by === "codex-canonico")!.id);
    const afterResolution = await mine.propose("after-resolution");
    expect(afterResolution.isError, afterResolution.content[0]?.text).not.toBe(true);
  });

  it("does not let expired proposals hold a slot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-12T12:00:00.000Z"));
    const { proposals } = bridge({ kind: "agent", name: "codex-canonico" });
    for (let index = 0; index < SCHEDULE_PROPOSAL_PENDING_CEILING; index += 1) {
      proposals.create(`stale-${index}`, { every: "1h", run: "test" }, "codex-canonico");
    }

    vi.advanceTimersByTime(SCHEDULE_PROPOSAL_TTL_MS);
    expect(() => proposals.create("fresh", { every: "1h", run: "test" }, "codex-canonico")).not.toThrow();
  });
});

describe("schedule proposal review window (t-d4f246)", () => {
  it("uses the Saved Agent 24h TTL and drops the row at the expiry boundary", () => {
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-ttl-"));
    roots.push(root);
    const proposal = new ProposalStore(root).create("nightly", { every: "1h", run: "test" }, "codex");
    expect(Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt)).toBe(SCHEDULE_PROPOSAL_TTL_MS);
    const input = { wsHash: "ws", folder: "repo", approvals: [], validations: [], scheduleProposals: [proposal] };
    expect(buildHumanInbox(input, { now: new Date(now + SCHEDULE_PROPOSAL_TTL_MS - 1).toISOString() })).toHaveLength(1);
    expect(buildHumanInbox(input, { now: new Date(now + SCHEDULE_PROPOSAL_TTL_MS).toISOString() })).toHaveLength(0);
  });
});
