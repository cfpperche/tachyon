import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentInternalPlan } from "@tachyon/engine/sidebar/readAgentInternalPlan.js";
import { readClaudeInternalPlan } from "@tachyon/engine/runtime/claudeInternalPlanReader.js";
import { readGrokInternalPlan } from "@tachyon/engine/runtime/grokInternalPlanReader.js";
import { readCodexTuiInternalPlan } from "@tachyon/engine/runtime/codexTuiInternalPlanReader.js";
import { grokInternalPlanUpdatesPath } from "@tachyon/engine/runtime/grokInternalPlanReader.js";

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

describe("t-281339 — readAgentInternalPlan (production doors)", () => {
  it("claude: opens the task store through readClaudeInternalPlan", () => {
    const home = temp();
    const sessionId = "sess-claude";
    const dir = path.join(home, "tasks", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ id: "1", subject: "claude step", status: "in-progress" }));
    const viaHost = readAgentInternalPlan({
      runtime: "claude",
      workspaceRoot: home,
      agent: "claude",
      sessionId,
      configHome: home,
    });
    expect(viaHost).toEqual(readClaudeInternalPlan({ configHome: home, sessionId }));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ id: "1", texto: "claude step", status: "in-progress" }],
    });
  });

  it("grok: opens updates.jsonl through readGrokInternalPlan", () => {
    const home = temp();
    const cwd = "/tmp/plan-cwd";
    const sessionId = "sess-grok";
    const file = grokInternalPlanUpdatesPath({ configHome: home, cwd, sessionId });
    fs.mkdirSync(path.dirname(file!), { recursive: true });
    fs.writeFileSync(file!, `${JSON.stringify({
      sessionUpdate: "plan",
      entries: [{ content: "grok step", status: "pending" }],
    })}\n`);
    const viaHost = readAgentInternalPlan({
      runtime: "grok",
      workspaceRoot: home,
      agent: "grok",
      cwd,
      sessionId,
      configHome: home,
    });
    expect(viaHost).toEqual(readGrokInternalPlan({ configHome: home, cwd, sessionId }));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ texto: "grok step", status: "pending" }],
    });
  });

  it("codex: opens the TUI ledger through readCodexTuiInternalPlan", () => {
    const root = temp();
    const ledger = path.join(root, ".tachyon", "activity", "codex-tool-hooks.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({
      agent: "coder",
      toolName: "update_plan",
      toolInput: { plan: [{ step: "codex step", status: "pending" }] },
    })}\n`);
    const viaHost = readAgentInternalPlan({
      runtime: "codex",
      workspaceRoot: root,
      agent: "coder",
    });
    expect(viaHost).toEqual(readCodexTuiInternalPlan(root, "coder"));
    expect(viaHost).toEqual({
      state: "snapshot",
      items: [{ texto: "codex step", status: "pending" }],
    });
  });

  it("unknown runtime or missing identity is mute — not sem-canal", () => {
    expect(readAgentInternalPlan({ runtime: "pi", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
    expect(readAgentInternalPlan({ runtime: "claude", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
    expect(readAgentInternalPlan({ runtime: "grok", workspaceRoot: "/ws", agent: "x" })).toEqual({ state: "mute" });
  });

  it("this suite imports the three production readers", () => {
    const source = fs.readFileSync(path.resolve("packages/engine/src/sidebar/readAgentInternalPlan.ts"), "utf8");
    expect(source).toMatch(/readClaudeInternalPlan/);
    expect(source).toMatch(/readGrokInternalPlan/);
    expect(source).toMatch(/readCodexTuiInternalPlan/);
  });
});
