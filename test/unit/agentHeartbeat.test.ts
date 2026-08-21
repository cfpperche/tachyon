import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLedger } from "@tachyon/engine/resume/SessionLedger.js";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { NoticeQueue } from "@tachyon/engine/workspace/NoticeQueue.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function ledgerFixture(name = "child") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-heartbeat-"));
  roots.push(root);
  const ledger = new SessionLedger(root);
  const epoch = ledger.allocateHeartbeatEpoch(name);
  ledger.record(name, {
    cwd: root,
    def: { cmd: "codex", kind: "agent", parent: "parent", heartbeat: { event: "agent.child-idle", epoch } },
  });
  return { root, ledger, epoch, name };
}

type Wake = (this: unknown, child: string, cursor: string) => Promise<void>;
const wake = (Workspace.prototype as unknown as { wakeParentOnChildIdle: Wake }).wakeParentOnChildIdle;

function heartbeatHarness() {
  const fixture = ledgerFixture();
  const queue = new NoticeQueue();
  let parentBusy = false;
  const submitted: string[] = [];
  const deliverNotice = vi.fn(async (target: string, line: string, metadata: unknown) => {
    if (parentBusy) { queue.enqueue(target, line, metadata as never); return { status: "queued" }; }
    submitted.push(line);
    return { status: "notified" };
  });
  const scope = {
    ledger: fixture.ledger,
    monitor: { hasStartedTurn: () => true },
    manager: { parentOf: () => "parent", session: (name: string) => name },
    tmux: { hasSession: async () => true },
    deliverNotice,
  };
  return { ...fixture, scope, queue, submitted, deliverNotice, setBusy: (value: boolean) => { parentBusy = value; } };
}

describe("t-21e115 — agent.child-idle heartbeat slice", () => {
  it("does not wake without a new idle cursor", async () => {
    const h = heartbeatHarness();
    await wake.call(h.scope, h.name, "idle-1");
    await wake.call(h.scope, h.name, "idle-1");
    expect(h.deliverNotice).toHaveBeenCalledTimes(1);
  });

  it("does not treat the initial post-spawn idle state as work", async () => {
    const h = heartbeatHarness();
    const scope = { ...h.scope, monitor: { hasStartedTurn: () => false } };
    await wake.call(scope, h.name, "initial-idle");
    expect(h.deliverNotice).not.toHaveBeenCalled();
    expect(h.ledger.get(h.name)?.def?.heartbeat?.cursor).toBeUndefined();
  });

  it("defers through NoticeQueue while the parent is busy instead of interrupting", async () => {
    const h = heartbeatHarness();
    h.setBusy(true);
    await wake.call(h.scope, h.name, "idle-1");
    expect(h.submitted).toEqual([]);
    expect(h.queue.peek("parent")?.line).toContain("agent.child-idle");
  });

  it("preserves the cursor across an engine restart", async () => {
    const h = heartbeatHarness();
    await wake.call(h.scope, h.name, "idle-1");
    const restartedScope = { ...h.scope, ledger: new SessionLedger(h.root), deliverNotice: vi.fn() };
    await wake.call(restartedScope, h.name, "idle-1");
    expect(restartedScope.deliverNotice).not.toHaveBeenCalled();
  });

  it("fences a delayed wake when a dismissed name is reused", async () => {
    const h = heartbeatHarness();
    const oldEpoch = h.epoch;
    h.ledger.remove(h.name);
    const newEpoch = h.ledger.allocateHeartbeatEpoch(h.name);
    h.ledger.record(h.name, {
      cwd: h.root,
      def: { cmd: "codex", kind: "agent", parent: "parent", heartbeat: { event: "agent.child-idle", epoch: newEpoch } },
    });
    expect(newEpoch).toBe(oldEpoch + 1);
    expect(h.ledger.advanceHeartbeatCursor(h.name, oldEpoch, "late-idle")).toBe(false);
    expect(h.ledger.get(h.name)?.def?.heartbeat?.cursor).toBeUndefined();
  });
});
