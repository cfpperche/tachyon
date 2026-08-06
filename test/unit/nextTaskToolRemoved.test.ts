import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";

/**
 * t-a4ac02 — remove the Bridge tool `next_task`; keep the pure function `nextTask()`.
 *
 * Two things share a name. The TOOL was an agent-pull path nobody walks (coordinator push via
 * spawn_agent(claim_task:) is the load-bearing claim). The FUNCTION still computes Mission Control
 * spotlight per chip. This file is the source/registry gate for that split:
 *   1. registerTools must NOT expose `next_task`
 *   2. boardSnapshot must still call nextTask() for each chip
 *
 * RED before GREEN: this file was written while the tool was still registered, observed failing,
 * then the registration was deleted and the suite turned green.
 */

class ToolCapture {
  names = new Set<string>();
  registerTool(name: string, _schema: unknown, _handler: unknown) {
    this.names.add(name);
  }
}

function liveToolNames(): Set<string> {
  const mcp = new ToolCapture();
  registerTools(mcp as never, { workspaceRoot: "/repo", caller: { kind: "agent", name: "ada" } } as never);
  return mcp.names;
}

describe("t-a4ac02 — Bridge tool next_task removed; function nextTask kept", () => {
  it("does not register next_task as a Bridge tool", () => {
    const registered = liveToolNames();
    expect(registered.has("next_task"), "next_task must not be registered after t-a4ac02").toBe(false);
    // Neighbours in the same capability module stay; this is not a wipe of tasks tools.
    expect(registered.has("list_tasks")).toBe(true);
    expect(registered.has("create_task")).toBe(true);
    expect(registered.has("update_task")).toBe(true);
    expect(registered.has("get_task")).toBe(true);
  });

  it("boardSnapshot still imports and uses the nextTask function for chip spotlight", () => {
    const root = path.resolve(__dirname, "../..");
    const snapshotSrc = fs.readFileSync(path.join(root, "src/tasks/boardSnapshot.ts"), "utf8");
    const fnSrc = fs.readFileSync(path.join(root, "src/tasks/nextTask.ts"), "utf8");

    expect(fnSrc).toMatch(/export function nextTask\b/);
    expect(snapshotSrc).toMatch(/from ["']\.\/nextTask\.js["']/);
    expect(snapshotSrc).toMatch(/next:\s*nextTask\s*\(/);
  });
});
