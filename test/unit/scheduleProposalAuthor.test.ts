import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { ProposalStore, SCHEDULE_PROPOSAL_TTL_MS } from "../../src/schedule/ProposalStore.js";
import { buildHumanInbox } from "../../src/humanInbox/model.js";
import type { CallerSnapshot } from "../../src/bridge/callerIdentity.js";

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
    fs.writeFileSync(path.join(dir, "agent.yml"), "schemaVersion: 1\nagentId: 123e4567-e89b-42d3-a456-426614174000\nruntime:\n  adapter: claude\n  executable: claude\ngrants:\n  proposeSavedAgent: true\n");
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
  return { proposals, toasts, propose };
}

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
      const result = await propose("nightly");
      expect(result.isError, expected).toBe(true);
      expect(proposals.list()).toEqual([]);
    }
  });

  it("takes no author from the arguments — nobody proposes in someone else's name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-author-"));
    roots.push(root);
    const proposals = new ProposalStore(root);
    const dir = path.join(root, ".tachyon", "agents", "claude-opus5-3");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.yml"), "schemaVersion: 1\nagentId: 123e4567-e89b-42d3-a456-426614174000\nruntime:\n  adapter: claude\n  executable: claude\ngrants:\n  proposeSavedAgent: true\n");
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
