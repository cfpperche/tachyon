import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { ProposalStore } from "../../src/schedule/ProposalStore.js";
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bridge(caller: CallerSnapshot | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-author-"));
  roots.push(root);
  const proposals = new ProposalStore(root);
  const toasts: Array<{ name: string; by: string }> = [];
  const mcp = new FakeMcp();
  const deps = {
    manager: undefined as never,
    tmux: undefined as never,
    pins: undefined as never,
    notify: () => {},
    proposals,
    onScheduleProposed: (name: string, by: string) => { toasts.push({ name, by }); },
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
    await propose("nightly");

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
    const mcp = new FakeMcp();
    registerTools(mcp as never, {
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      notify: () => {},
      proposals,
      caller: { kind: "agent", name: "claude-opus5-3" },
    } satisfies Partial<BridgeDeps> as unknown as BridgeDeps);

    // Author-looking arguments are not part of the tool's input and must not reach the record.
    await mcp.handlers.get("propose_schedule")!({
      name: "nightly", every: "1h", run: "test",
      by: "codex-canonico", agent: "codex-canonico", author: "codex-canonico", requester: "codex-canonico",
    });

    expect(proposals.list()[0]?.by).toBe("claude-opus5-3");
  });
});
