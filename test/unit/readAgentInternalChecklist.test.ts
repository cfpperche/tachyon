import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentInternalChecklist } from "@tachyon/engine/sidebar/readAgentInternalChecklist.js";
import { readClaudeInternalChecklist } from "@tachyon/engine/runtime/claudeInternalChecklistReader.js";
import { readGrokInternalChecklist } from "@tachyon/engine/runtime/grokInternalChecklistReader.js";
import { readCodexTuiInternalChecklist } from "@tachyon/engine/runtime/codexTuiInternalChecklistReader.js";
import { grokInternalChecklistUpdatesPath } from "@tachyon/engine/runtime/grokInternalChecklistReader.js";

/**
 * t-281339 — the host door for the three fatia-1 readers. Disconnecting
 * any runtime (always mute, or a canned projection) turns this file red.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-plan-"));
  dirs.push(root);
  return root;
}

describe("t-281339 — readAgentInternalChecklist (production doors)", () => {
  it("claude: opens the task store through readClaudeInternalChecklist", () => {
    const home = temp();
    const sessionId = "sess-claude";
    const dir = path.join(home, "tasks", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ id: "1", subject: "claude step", status: "in-progress" }));
    const viaHost = readAgentInternalChecklist({
      runtime: "claude",
      workspaceRoot: home,
      agent: "claude",
      sessionId,
      configHome: home,
    });
    expect(viaHost).toEqual(readClaudeInternalChecklist({ configHome: home, sessionId }));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ id: "1", text: "claude step", status: "in-progress" }],
    });
  });

  it("grok: opens updates.jsonl through readGrokInternalChecklist", () => {
    const home = temp();
    const cwd = "/tmp/plan-cwd";
    const sessionId = "sess-grok";
    const file = grokInternalChecklistUpdatesPath({ configHome: home, cwd, sessionId });
    fs.mkdirSync(path.dirname(file!), { recursive: true });
    fs.writeFileSync(file!, `${JSON.stringify({
      sessionUpdate: "plan",
      entries: [{ content: "grok step", status: "pending" }],
    })}\n`);
    const viaHost = readAgentInternalChecklist({
      runtime: "grok",
      workspaceRoot: home,
      agent: "grok",
      cwd,
      sessionId,
      configHome: home,
    });
    expect(viaHost).toEqual(readGrokInternalChecklist({ configHome: home, cwd, sessionId }));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ text: "grok step", status: "pending" }],
    });
  });

  it("codex: opens the TUI ledger through readCodexTuiInternalChecklist", () => {
    const root = temp();
    const ledger = path.join(root, ".tachyon", "activity", "codex-tool-hooks.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({
      agent: "coder",
      toolName: "update_plan",
      toolInput: { plan: [{ step: "codex step", status: "pending" }] },
    })}\n`);
    const viaHost = readAgentInternalChecklist({
      runtime: "codex",
      workspaceRoot: root,
      agent: "coder",
    });
    expect(viaHost).toEqual(readCodexTuiInternalChecklist(root, "coder"));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ text: "codex step", status: "pending" }],
    });
  });

  it("unknown runtime or missing identity is mute — not no-channel", () => {
    expect(readAgentInternalChecklist({ runtime: "pi", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
    expect(readAgentInternalChecklist({ runtime: "claude", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
    expect(readAgentInternalChecklist({ runtime: "grok", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
  });

  it("this suite imports the three production readers", () => {
    const source = fs.readFileSync(path.resolve("packages/engine/src/sidebar/readAgentInternalChecklist.ts"), "utf8");
    expect(source).toMatch(/readClaudeInternalChecklist/);
    expect(source).toMatch(/readGrokInternalChecklist/);
    expect(source).toMatch(/readCodexTuiInternalChecklist/);
  });
});
