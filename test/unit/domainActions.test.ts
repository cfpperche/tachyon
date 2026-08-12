import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as domainActions from "../../src/workspace/domainActions.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { Pin } from "../../src/pins/PinStore.js";
import type { ViewKind } from "../../src/workspace/EngineHost.js";

function fakeWorkspace(pins: Pin[] = []): Workspace {
  const calls: string[] = [];
  return {
    pinStore: {
      list: () => pins,
      setDone: (id: string, done: boolean) => {
        const pin = pins.find((p) => p.id === id);
        if (!pin) throw new Error(`unknown pin '${id}'`);
        pin.done = done;
        return pin;
      },
      remove: (id: string) => {
        const idx = pins.findIndex((p) => p.id === id);
        if (idx < 0) throw new Error(`unknown pin '${id}'`);
        pins.splice(idx, 1);
      },
    },
    toggleSchedulePause: (name: string) => { calls.push(`pause:${name}`); },
    deleteScheduleEntry: (name: string) => { calls.push(`delete-schedule:${name}`); },
    approveProposal: (id: string) => {
      calls.push(`approve:${id}`);
      return id !== "missing";
    },
    rejectProposal: (id: string) => { calls.push(`reject:${id}`); },
    __calls: calls,
  } as unknown as Workspace;
}

function pin(id: string, done = false): Pin {
  return { id, text: id, by: "human", createdAt: "2026-06-25T00:00:00.000Z", done };
}

describe("domainActions", () => {
  it("toggles an existing pin and emits one pins refresh", async () => {
    const ws = fakeWorkspace([pin("p-1")]);
    const changed: ViewKind[] = [];

    expect(await domainActions.togglePinDone(ws, "p-1", true, { onChanged: (v) => changed.push(v) })).toBe(true);

    expect(ws.pinStore.list()[0]?.done).toBe(true);
    expect(changed).toEqual(["pins"]);
  });

  it("deletes only the targeted pin and preserves sibling order", async () => {
    const ws = fakeWorkspace([pin("p-delete"), pin("p-keep-1"), pin("p-keep-2")]);
    const changed: ViewKind[] = [];

    expect(await domainActions.deletePin(ws, "p-delete", { onChanged: (v) => changed.push(v) })).toBe(true);

    expect(ws.pinStore.list().map((p) => p.id)).toEqual(["p-keep-1", "p-keep-2"]);
    expect(changed).toEqual(["pins"]);
  });

  it("treats stale pin actions as quiet no-ops", async () => {
    const ws = fakeWorkspace([pin("p-keep")]);
    const changed: ViewKind[] = [];

    expect(await domainActions.togglePinDone(ws, "p-missing", true, { onChanged: (v) => changed.push(v) })).toBe(false);
    expect(await domainActions.deletePin(ws, "p-missing", { onChanged: (v) => changed.push(v) })).toBe(false);

    expect(ws.pinStore.list().map((p) => p.id)).toEqual(["p-keep"]);
    expect(changed).toEqual([]);
  });

  it("delegates schedule and proposal mutations to the workspace contract", async () => {
    const ws = fakeWorkspace();

    const deps = { onChanged: () => {} };

    expect(domainActions.toggleSchedulePause(ws, "nightly", deps)).toBe(true);
    expect(domainActions.deleteSchedule(ws, "nightly", deps)).toBe(true);
    expect(domainActions.approveProposal(ws, "proposal-1", deps)).toBe(true);
    expect(domainActions.approveProposal(ws, "missing", deps)).toBe(false);
    expect(domainActions.rejectProposal(ws, "proposal-2", deps)).toBe(true);

    expect((ws as unknown as { __calls: string[] }).__calls).toEqual([
      "pause:nightly",
      "delete-schedule:nightly",
      "approve:proposal-1",
      "approve:missing",
      "reject:proposal-2",
    ]);
  });

  it("routes matching VS Code command handlers through the persistent sidebar mutation contract", async () => {
    const source = fs.readFileSync("src/extension.ts", "utf8");

    for (const [command, action] of [
      ["tachyon.approveProposalItem", 'action: "proposal.approve"'],
      ["tachyon.rejectProposalItem", 'action: "proposal.reject"'],
      ["tachyon.toggleSchedulePauseItem", 'action: "schedule.toggle-pause"'],
      ["tachyon.deleteScheduleItem", 'action: "schedule.delete"'],
      ["tachyon.deletePinItem", 'action: "pin.delete"'],
    ]) {
      const start = source.indexOf(`registerCommand("${command}"`);
      expect(start, `${command} is registered`).toBeGreaterThanOrEqual(0);
      const next = source.indexOf("vscode.commands.registerCommand", start + 1);
      const block = source.slice(start, next >= 0 ? next : undefined);
      expect(block, `${command} uses the remote sidebar mutation`).toContain("sidebar.mutateSidebar");
      expect(block, `${command} delegates to ${action}`).toContain(action);
    }
  });
});
