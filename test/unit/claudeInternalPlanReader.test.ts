import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_INTERNAL_PLAN_TOOLS,
  CLAUDE_SUBAGENT_TOOLS,
  claudeInternalPlanToolsPresent,
  readClaudeInternalPlan,
} from "@tachyon/engine/runtime/claudeInternalPlanReader.js";

/**
 * t-96c1b3 — the production Claude plan reader, driven by the store a real authenticated
 * session wrote (PoC 2026-08-16, session 11111111-b3dd-4969-a001-000000000041).
 *
 * These tests import `readClaudeInternalPlan` — the host door. A helper-only parser that
 * the host never calls will not satisfy them. Disconnecting the reader (always mute, or a
 * canned projection that does not open the store) turns the suite red.
 */

const FIXTURE_HOME = path.resolve("test/fixtures/claude-internal-plan");
const MEASURED_SESSION = "11111111-b3dd-4969-a001-000000000041";

const FLAG_OFF_TOOLS = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_HOME, "init-tools-default.json"), "utf8"),
) as { tools: string[]; env: Record<string, string> };
const FLAG_ON_TOOLS = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_HOME, "init-tools-todo-tools.json"), "utf8"),
) as { tools: string[]; env: Record<string, string> };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-plan-"));
  dirs.push(root);
  return root;
}

describe("t-96c1b3 — measured Claude plan-tool inventory", () => {
  it("flag-off init.tools has the subagent family and no TaskCreate family", () => {
    expect(FLAG_OFF_TOOLS.env).toEqual({});
    expect(FLAG_OFF_TOOLS.tools).toEqual(expect.arrayContaining([...CLAUDE_SUBAGENT_TOOLS]));
    for (const name of CLAUDE_INTERNAL_PLAN_TOOLS) {
      expect(FLAG_OFF_TOOLS.tools).not.toContain(name);
    }
    expect(claudeInternalPlanToolsPresent(FLAG_OFF_TOOLS.tools)).toBe(false);
  });

  it("flag-on init.tools has the TaskCreate family, still distinct from the subagent family", () => {
    expect(FLAG_ON_TOOLS.env).toEqual({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
    expect(FLAG_ON_TOOLS.tools).toEqual(expect.arrayContaining([...CLAUDE_INTERNAL_PLAN_TOOLS]));
    expect(FLAG_ON_TOOLS.tools).toEqual(expect.arrayContaining([...CLAUDE_SUBAGENT_TOOLS]));
    expect(claudeInternalPlanToolsPresent(FLAG_ON_TOOLS.tools)).toBe(true);
  });

  it("does not treat Task / TaskOutput / TaskStop as the plan channel", () => {
    expect(claudeInternalPlanToolsPresent(["Task", "TaskOutput", "TaskStop"])).toBe(false);
    expect(claudeInternalPlanToolsPresent(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"])).toBe(true);
  });
});

describe("t-96c1b3 — readClaudeInternalPlan (production door)", () => {
  it("projects the measured authenticated session with id and blockedBy preserved", () => {
    const plan = readClaudeInternalPlan({
      configHome: FIXTURE_HOME,
      sessionId: MEASURED_SESSION,
    });
    expect(plan).toEqual({
      state: "snapshot",
      items: [
        { id: "1", texto: "PLAN_B_4VJ8P2 root", status: "pending" },
        { id: "2", texto: "PLAN_B_4VJ8P2 child", status: "pending", blockedBy: ["1"] },
      ],
    });
  });

  it("is mute when the session store is absent, and empty when the channel spoke with no items", () => {
    const home = tempHome();
    expect(readClaudeInternalPlan({ configHome: home, sessionId: MEASURED_SESSION })).toEqual({
      state: "mute",
    });
    fs.mkdirSync(path.join(home, "tasks", "spoken-empty"), { recursive: true });
    fs.writeFileSync(path.join(home, "tasks", "spoken-empty", ".lock"), "");
    expect(readClaudeInternalPlan({ configHome: home, sessionId: "spoken-empty" })).toEqual({
      state: "snapshot",
      items: [],
    });
  });

  it("fails if the reader does not open the store (red proof)", () => {
    const home = tempHome();
    const sessionId = "red-proof-session";
    fs.mkdirSync(path.join(home, "tasks", sessionId), { recursive: true });
    fs.writeFileSync(
      path.join(home, "tasks", sessionId, "9.json"),
      JSON.stringify({
        id: "9",
        subject: "CANARY_STORE_READ",
        status: "completed",
        blockedBy: ["8"],
      }),
    );
    expect(readClaudeInternalPlan({ configHome: home, sessionId })).toEqual({
      state: "snapshot",
      items: [{ id: "9", texto: "CANARY_STORE_READ", status: "completed", blockedBy: ["8"] }],
    });
  });

  it("does not invent an id when the store row has none", () => {
    const home = tempHome();
    const sessionId = "no-id";
    fs.mkdirSync(path.join(home, "tasks", sessionId), { recursive: true });
    fs.writeFileSync(
      path.join(home, "tasks", sessionId, "orphan.json"),
      JSON.stringify({ subject: "no identity", status: "in_progress" }),
    );
    expect(readClaudeInternalPlan({ configHome: home, sessionId })).toEqual({
      state: "snapshot",
      items: [{ texto: "no identity", status: "in-progress" }],
    });
  });

  it("this suite calls the production reader, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/claudeInternalPlanReader.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/claudeInternalPlanReader\.js"/);
    expect(source).toMatch(/readClaudeInternalPlan\(/);
    expect(source).not.toMatch(/function readClaudeInternalPlan\(/);
  });
});
