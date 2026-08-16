import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { considerInternalChecklistReprompt } from "@tachyon/engine/runtime/internalChecklistReprompt.js";
import type { InternalChecklistTurnJudgment } from "@tachyon/engine/runtime/internalChecklistTurn.js";

/**
 * t-73885b — fatia 4. These tests import `considerInternalChecklistReprompt` —
 * the host door that consumes a fatia-2 verdict. A helper that always
 * reprompts, or that reprompts on `no-channel` / `pending`, turns the
 * suite red.
 */

const ABSENT: InternalChecklistTurnJudgment = { state: "verdict", verdict: "absent" };
const PRESENT: InternalChecklistTurnJudgment = { state: "verdict", verdict: "present" };
const NO_CHANNEL: InternalChecklistTurnJudgment = { state: "verdict", verdict: "no-channel" };
const PENDING_OPEN: InternalChecklistTurnJudgment = { state: "pending", reason: "turn-open" };
const PENDING_DEAD: InternalChecklistTurnJudgment = { state: "pending", reason: "turn-not-completed" };

function consider(opts: {
  judgment?: InternalChecklistTurnJudgment;
  taskKind?: string;
  requireIn?: readonly unknown[];
  alreadyReprompted?: boolean;
}) {
  return considerInternalChecklistReprompt({
    judgment: opts.judgment ?? ABSENT,
    taskKind: opts.taskKind,
    requireIn: opts.requireIn,
    alreadyReprompted: opts.alreadyReprompted ?? false,
  });
}

function loadedRequireIn(yaml: string): readonly string[] | undefined {
  const { config, errors } = parseConfig(yaml);
  expect(errors).toEqual([]);
  return config?.settings?.checklist?.requireIn;
}

describe("t-73885b — considerInternalChecklistReprompt (production door)", () => {
  describe("the seven requireIn forms", () => {
    it("absent or [] requires nobody", () => {
      expect(consider({ taskKind: "feature" }).action).toBe("none");
      expect(consider({ taskKind: "feature", requireIn: [] }).action).toBe("none");
      expect(loadedRequireIn("agents:\n  a:\n    cmd: x\n")).toBeUndefined();
      expect(loadedRequireIn("settings:\n  checklist:\n    requireIn: []\n")).toEqual([]);
    });

    it("[feature] requires only that kind", () => {
      expect(consider({ taskKind: "feature", requireIn: ["feature"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "bug", requireIn: ["feature"] }).action).toBe("none");
      expect(consider({ requireIn: ["feature"] }).action).toBe("none");
      expect(loadedRequireIn("settings:\n  checklist:\n    requireIn: [feature]\n")).toEqual(["feature"]);
    });

    it("[feature, bug] requires both", () => {
      expect(consider({ taskKind: "feature", requireIn: ["feature", "bug"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "bug", requireIn: ["feature", "bug"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", requireIn: ["feature", "bug"] }).action).toBe("none");
      expect(loadedRequireIn("settings:\n  checklist:\n    requireIn: [feature, bug]\n")).toEqual(["feature", "bug"]);
    });

    it("[*] requires every kind, including one that does not exist yet", () => {
      expect(consider({ taskKind: "feature", requireIn: ["*"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "not-a-real-kind-yet", requireIn: ["*"] }).action).toBe("reprompt");
      expect(consider({ requireIn: ["*"] }).action).toBe("reprompt");
      expect(loadedRequireIn('settings:\n  checklist:\n    requireIn: ["*"]\n')).toEqual(["*"]);
    });

    it("[*, !chore] requires everything except chore", () => {
      expect(consider({ taskKind: "feature", requireIn: ["*", "!chore"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", requireIn: ["*", "!chore"] }).action).toBe("none");
      expect(consider({ requireIn: ["*", "!chore"] }).action).toBe("reprompt");
      expect(loadedRequireIn('settings:\n  checklist:\n    requireIn: ["*", "!chore"]\n')).toEqual(["*", "!chore"]);
    });

    it("[!chore] is treated as [*, !chore]", () => {
      expect(consider({ taskKind: "feature", requireIn: ["!chore"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", requireIn: ["!chore"] }).action).toBe("none");
      expect(consider({ requireIn: ["!chore"] }).action).toBe("reprompt");
      expect(loadedRequireIn('settings:\n  checklist:\n    requireIn: ["!chore"]\n')).toEqual(["!chore"]);
    });

    it("exclusion wins: [feature, !feature] requires nothing", () => {
      expect(consider({ taskKind: "feature", requireIn: ["feature", "!feature"] }).action).toBe("none");
      expect(loadedRequireIn('settings:\n  checklist:\n    requireIn: [feature, "!feature"]\n')).toEqual(["feature", "!feature"]);
    });
  });

  it("compares kind case-insensitively with trim", () => {
    expect(consider({ taskKind: " Feature ", requireIn: ["FEATURE"] }).action).toBe("reprompt");
    expect(consider({ taskKind: "CHORE", requireIn: ["*", "! Chore"] }).action).toBe("none");
  });

  it("a kind in the config that no task uses does not match and does not warn", () => {
    const parsed = parseConfig("settings:\n  checklist:\n    requireIn: [feature, nobody-uses-this]\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config?.settings?.checklist?.requireIn).toEqual(["feature", "nobody-uses-this"]);
    expect(consider({ taskKind: "bug", requireIn: parsed.config?.settings?.checklist?.requireIn }).action).toBe("none");
  });

  it("invalid checklist warns and the rest of the file still loads", () => {
    const parsed = parseConfig("agents:\n  a:\n    cmd: x\nsettings:\n  checklist: 1\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents.a?.cmd).toBe("x");
    expect(parsed.config?.settings?.checklist).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("checklist"))).toBe(true);
    expect(consider({ taskKind: "feature", requireIn: parsed.config?.settings?.checklist?.requireIn }).action).toBe("none");
  });

  it("invalid requireIn warns and requires nobody", () => {
    const parsed = parseConfig("agents:\n  a:\n    cmd: x\nsettings:\n  checklist:\n    requireIn: feature\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents.a?.cmd).toBe("x");
    expect(parsed.config?.settings?.checklist).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("requireIn"))).toBe(true);
  });

  it("absent + required kind reprompts once and only once", () => {
    const first = consider({ taskKind: "feature", requireIn: ["feature"] });
    expect(first.action).toBe("reprompt");
    expect(first.prompt).toMatch(/checklist/i);
    expect(first.prompt).toMatch(/only reminder|only once/i);

    const second = consider({
      taskKind: "feature",
      requireIn: ["feature"],
      alreadyReprompted: true,
    });
    expect(second.action).toBe("give-up");
    expect(second.prompt).toBeUndefined();
    expect(second.journal).toMatch(/checklist/i);
    expect(second.journal).toMatch(/not blocked|does not block/i);
  });

  it("no-channel does not reprompt", () => {
    expect(consider({ judgment: NO_CHANNEL, taskKind: "feature", requireIn: ["feature"] }).action).toBe("none");
  });

  it("pending (turn-open and turn-not-completed) does not reprompt", () => {
    expect(consider({ judgment: PENDING_OPEN, taskKind: "feature", requireIn: ["feature"] }).action).toBe("none");
    expect(consider({ judgment: PENDING_DEAD, taskKind: "feature", requireIn: ["feature"] }).action).toBe("none");
  });

  it("present does not reprompt", () => {
    expect(consider({ judgment: PRESENT, taskKind: "feature", requireIn: ["feature"] }).action).toBe("none");
  });

  it("a task whose kind is not required does not reprompt", () => {
    expect(consider({ taskKind: "chore", requireIn: ["feature"] }).action).toBe("none");
  });

  it("this suite calls the production door, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/internalChecklistReprompt.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/internalChecklistReprompt\.js"/);
    expect(source).toMatch(/considerInternalChecklistReprompt\(/);
    expect(source).not.toMatch(/function considerInternalChecklistReprompt\(/);
  });

  it("Workspace and the monitor call the production door", () => {
    const workspace = fs.readFileSync(path.resolve("packages/engine/src/workspace/Workspace.ts"), "utf8");
    const monitor = fs.readFileSync(
      path.resolve("packages/engine/src/workspace/InternalChecklistRepromptMonitor.ts"),
      "utf8",
    );
    expect(monitor).toMatch(/from "\.\.\/runtime\/internalChecklistReprompt\.js"/);
    expect(monitor).toMatch(/considerInternalChecklistReprompt\(/);
    expect(monitor).not.toMatch(/function considerInternalChecklistReprompt\(/);
    expect(workspace).toMatch(/internalChecklistReprompt\.tick\(/);
  });
});
