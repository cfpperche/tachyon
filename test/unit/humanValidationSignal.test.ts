import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { routeHumanValidationPending } from "../../src/engine-service/engineService.js";
import type { CallerSnapshot } from "../../src/bridge/callerIdentity.js";

/**
 * Symmetric human signals for validations (t-e76acc, report § 1.1 "Human signals: **none**").
 *
 * An approval notifies its human the moment it is recorded; a validation reserved for a human never
 * did — it only refreshed a view someone had to already be looking at. This closes that gap with the
 * SAME notice affordance, and deliberately WITHOUT the part that carries authority: resolving an
 * approval injects into the requester's tmux session because an agent is blocked on it. Nothing is
 * blocked on a validation, so nothing is injected.
 */
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

function bridge(caller: CallerSnapshot | undefined = { kind: "agent", name: "codex-canonico" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-human-validation-signal-"));
  roots.push(root);
  const validations = new ValidationStore(root);
  const pending: Array<{ id: string; title: string; author: string }> = [];
  const mcp = new FakeMcp();
  const deps = {
    manager: undefined as never,
    tmux: undefined as never,
    pins: undefined as never,
    notify: () => {},
    validations,
    onValidationsChanged: () => {},
    onHumanValidationPending: (v: { id: string; title: string; author: string }) => { pending.push(v); },
    ...(caller ? { caller } : {}),
  } satisfies Partial<BridgeDeps> as unknown as BridgeDeps;
  registerTools(mcp as never, deps);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const handler = mcp.handlers.get(tool);
    if (!handler) throw new Error(`${tool} is not registered`);
    const res = await handler(args);
    return { res, parsed: JSON.parse(res.content[0].text) as { id: string; executor: string } };
  };
  return { validations, pending, call };
}

describe("a validation that lands on a human raises the same signal an approval does", () => {
  it("fires when one is created for a human", async () => {
    const { pending, call } = bridge();
    const { parsed } = await call("create_validation", { title: "dogfood the inbox", executor: "human", agent: "codex-canonico" });
    expect(pending).toEqual([{ id: parsed.id, title: "dogfood the inbox", author: "codex-canonico" }]);
  });

  it("stays silent for work the fleet can do itself", async () => {
    const { pending, call } = bridge();
    await call("create_validation", { title: "regenerate fixtures", executor: "agent" });
    await call("create_validation", { title: "spot check", executor: "either" });
    // "either" is not a human's queue: it is work anyone can pick up, and notifying on it would
    // train the human to ignore the signal that matters.
    expect(pending).toEqual([]);
  });

  it("fires on the HANDOVER — when an agent's validation becomes a human's", async () => {
    const { pending, call } = bridge();
    const { parsed } = await call("create_validation", { title: "check the render", executor: "agent" });
    expect(pending).toEqual([]);

    await call("update_validation", { id: parsed.id, executor: "human" });
    expect(pending).toEqual([{ id: parsed.id, title: "check the render", author: "codex-canonico" }]);
  });

  it("does not re-notify when an already-human validation is merely edited", async () => {
    const { pending, call } = bridge();
    const { parsed } = await call("create_validation", { title: "read the evidence", executor: "human" });
    expect(pending).toHaveLength(1);

    await call("update_validation", { id: parsed.id, title: "read the evidence carefully" });
    await call("update_validation", { id: parsed.id, priority: 1 });
    // a re-titled validation is not new work arriving; repeating the notice is how a signal becomes
    // noise, which is the failure mode the approval notice already avoids.
    expect(pending).toHaveLength(1);
  });

  it("names a non-agent caller as human rather than dressing it up", async () => {
    const { pending, call } = bridge({ kind: "human" });
    await call("create_validation", { title: "manual QA", executor: "human" });
    expect(pending[0]?.author).toBe("human");
  });
});

describe("the notice it produces", () => {
  it("offers Review → the Human Inbox, and carries no decision authority", async () => {
    const notices: Array<{ text: string; level: string; actions: Array<{ label: string; run: () => Promise<void> }> }> = [];
    const executed: Array<{ command: string; arg: unknown }> = [];
    const host = {
      t: (template: string, ...args: string[]) => template.replace(/\{(\d)\}/g, (_m, i) => args[Number(i)] ?? ""),
      notify: (text: string, level: string, actions: Array<{ label: string; run: () => Promise<void> }>) => {
        notices.push({ text, level, actions });
      },
      executeCommand: async (command: string, arg: unknown) => {
        executed.push({ command, arg });
      },
    };

    routeHumanValidationPending(host as never, "ws-1", { id: "v-1", title: "read the evidence", author: "codex-canonico" });

    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("v-1");
    expect(notices[0].text).toContain("read the evidence");
    expect(notices[0].text).toContain("codex-canonico");
    expect(notices[0].level).toBe("info");

    await notices[0].actions[0].run();
    // one destination for "what is waiting on me" — not the per-kind section
    expect(executed).toEqual([{ command: "tachyon.openHumanInbox", arg: "ws-1" }]);
  });
});
