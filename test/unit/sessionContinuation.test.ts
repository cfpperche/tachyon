import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFocusedHandoffMarkdown, writeFocusedHandoff } from "../../src/sessionContinuation/focusedHandoff.js";
import { prepareContinueTask } from "../../src/sessionContinuation/continueTask.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("focused handoff (t-7551f9)", () => {
  it("markdown states new session and repo authority", () => {
    const md = buildFocusedHandoffMarkdown({
      fromAgent: "codex",
      fromCmd: "codex",
      toAgent: "claude",
      toCmd: "claude",
      reason: "usage limit",
      taskSummary: "Land the feature",
      recentProgress: ["Wrote adapters"],
      blockers: ["Need review"],
    });
    expect(md).toMatch(/new session/i);
    expect(md).toMatch(/not.*migrated/i);
    expect(md).toContain("usage limit");
    expect(md).toContain("Land the feature");
    expect(md).toContain("Wrote adapters");
  });

  it("writeFocusedHandoff persists under .tachyon/session-continuation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-handoff-"));
    tmpDirs.push(root);
    const packet = writeFocusedHandoff(root, {
      fromAgent: "a",
      fromCmd: "claude",
      toAgent: "b",
      toCmd: "codex",
    });
    const abs = path.join(root, packet.relPath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toContain(packet.id.split("-")[0]!); // sc prefix
    expect(packet.fromRuntime).toBe("claude");
    expect(packet.toRuntime).toBe("codex");
    expect(packet.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("prepareContinueTask", () => {
  it("rejects same agent and running dest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-prep-"));
    tmpDirs.push(root);
    expect(
      prepareContinueTask({
        workspaceRoot: root,
        fromAgent: "x",
        fromCmd: "claude",
        toAgent: "x",
        toCmd: "codex",
        toAgentRunning: false,
      }).ok,
    ).toBe(false);
    expect(
      prepareContinueTask({
        workspaceRoot: root,
        fromAgent: "x",
        fromCmd: "claude",
        toAgent: "y",
        toCmd: "codex",
        toAgentRunning: true,
      }).ok,
    ).toBe(false);
  });

  it("prepares taskBrief and writes packet when dest free", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-prep-ok-"));
    tmpDirs.push(root);
    const prep = prepareContinueTask({
      workspaceRoot: root,
      fromAgent: "codex",
      fromCmd: "codex",
      toAgent: "claude",
      toCmd: "claude",
      reason: "limit",
      toAgentRunning: false,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    expect(prep.taskBrief).toContain(prep.packet.relPath);
    expect(fs.existsSync(path.join(root, prep.packet.relPath))).toBe(true);
  });
});
