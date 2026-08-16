import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { considerInternalPlanReprompt } from "@tachyon/engine/runtime/internalPlanReprompt.js";
import type { InternalPlanTurnJudgment } from "@tachyon/engine/runtime/internalPlanTurn.js";

/**
 * t-73885b — fatia 4. These tests import `considerInternalPlanReprompt` —
 * the host door that consumes a fatia-2 verdict. A helper that always
 * remprompts, or that remprompts on `sem-canal` / `pending`, turns the
 * suite red.
 */

const SEM_PLANO: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-plano" };
const COM_PLANO: InternalPlanTurnJudgment = { state: "verdict", verdict: "com-plano" };
const SEM_CANAL: InternalPlanTurnJudgment = { state: "verdict", verdict: "sem-canal" };
const PENDING_OPEN: InternalPlanTurnJudgment = { state: "pending", reason: "turn-open" };
const PENDING_DEAD: InternalPlanTurnJudgment = { state: "pending", reason: "turn-not-completed" };

function consider(opts: {
  judgment?: InternalPlanTurnJudgment;
  taskKind?: string;
  exigirEm?: readonly unknown[];
  alreadyReprompted?: boolean;
}) {
  return considerInternalPlanReprompt({
    judgment: opts.judgment ?? SEM_PLANO,
    taskKind: opts.taskKind,
    exigirEm: opts.exigirEm,
    alreadyReprompted: opts.alreadyReprompted ?? false,
  });
}

function loadedExigirEm(yaml: string): readonly string[] | undefined {
  const { config, errors } = parseConfig(yaml);
  expect(errors).toEqual([]);
  return config?.plano?.exigir_em;
}

describe("t-73885b — considerInternalPlanReprompt (production door)", () => {
  describe("the seven exigir_em forms", () => {
    it("absent or [] requires nobody", () => {
      expect(consider({ taskKind: "feature" }).action).toBe("none");
      expect(consider({ taskKind: "feature", exigirEm: [] }).action).toBe("none");
      expect(loadedExigirEm("agents:\n  a:\n    cmd: x\n")).toBeUndefined();
      expect(loadedExigirEm("plano:\n  exigir_em: []\n")).toEqual([]);
    });

    it("[feature] requires only that kind", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["feature"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "bug", exigirEm: ["feature"] }).action).toBe("none");
      expect(consider({ exigirEm: ["feature"] }).action).toBe("none");
      expect(loadedExigirEm("plano:\n  exigir_em: [feature]\n")).toEqual(["feature"]);
    });

    it("[feature, bug] requires both", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["feature", "bug"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "bug", exigirEm: ["feature", "bug"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", exigirEm: ["feature", "bug"] }).action).toBe("none");
      expect(loadedExigirEm("plano:\n  exigir_em: [feature, bug]\n")).toEqual(["feature", "bug"]);
    });

    it("[*] requires every kind, including one that does not exist yet", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["*"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "not-a-real-kind-yet", exigirEm: ["*"] }).action).toBe("reprompt");
      expect(consider({ exigirEm: ["*"] }).action).toBe("reprompt");
      expect(loadedExigirEm('plano:\n  exigir_em: ["*"]\n')).toEqual(["*"]);
    });

    it("[*, !chore] requires everything except chore", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["*", "!chore"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", exigirEm: ["*", "!chore"] }).action).toBe("none");
      expect(consider({ exigirEm: ["*", "!chore"] }).action).toBe("reprompt");
      expect(loadedExigirEm('plano:\n  exigir_em: ["*", "!chore"]\n')).toEqual(["*", "!chore"]);
    });

    it("[!chore] is treated as [*, !chore]", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["!chore"] }).action).toBe("reprompt");
      expect(consider({ taskKind: "chore", exigirEm: ["!chore"] }).action).toBe("none");
      expect(consider({ exigirEm: ["!chore"] }).action).toBe("reprompt");
      expect(loadedExigirEm('plano:\n  exigir_em: ["!chore"]\n')).toEqual(["!chore"]);
    });

    it("exclusion wins: [feature, !feature] requires nothing", () => {
      expect(consider({ taskKind: "feature", exigirEm: ["feature", "!feature"] }).action).toBe("none");
      expect(loadedExigirEm('plano:\n  exigir_em: [feature, "!feature"]\n')).toEqual(["feature", "!feature"]);
    });
  });

  it("compares kind case-insensitively with trim", () => {
    expect(consider({ taskKind: " Feature ", exigirEm: ["FEATURE"] }).action).toBe("reprompt");
    expect(consider({ taskKind: "CHORE", exigirEm: ["*", "! Chore"] }).action).toBe("none");
  });

  it("a kind in the config that no task uses does not match and does not warn", () => {
    const parsed = parseConfig("plano:\n  exigir_em: [feature, nobody-uses-this]\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config?.plano?.exigir_em).toEqual(["feature", "nobody-uses-this"]);
    expect(consider({ taskKind: "bug", exigirEm: parsed.config?.plano?.exigir_em }).action).toBe("none");
  });

  it("invalid plano warns and the rest of the file still loads", () => {
    const parsed = parseConfig("agents:\n  a:\n    cmd: x\nplano: 1\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents.a?.cmd).toBe("x");
    expect(parsed.config?.plano).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("plano"))).toBe(true);
    expect(consider({ taskKind: "feature", exigirEm: parsed.config?.plano?.exigir_em }).action).toBe("none");
  });

  it("invalid exigir_em warns and requires nobody", () => {
    const parsed = parseConfig("agents:\n  a:\n    cmd: x\nplano:\n  exigir_em: feature\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents.a?.cmd).toBe("x");
    expect(parsed.config?.plano).toBeUndefined();
    expect(parsed.warnings.some((w) => w.includes("exigir_em"))).toBe(true);
  });

  it("sem-plano + required kind remprompts once and only once", () => {
    const first = consider({ taskKind: "feature", exigirEm: ["feature"] });
    expect(first.action).toBe("reprompt");
    expect(first.prompt).toMatch(/plan/i);
    expect(first.prompt).toMatch(/only reminder|only once/i);

    const second = consider({
      taskKind: "feature",
      exigirEm: ["feature"],
      alreadyReprompted: true,
    });
    expect(second.action).toBe("give-up");
    expect(second.prompt).toBeUndefined();
    expect(second.journal).toMatch(/plan/i);
    expect(second.journal).toMatch(/not blocked|does not block/i);
  });

  it("sem-canal does not remprompt", () => {
    expect(consider({ judgment: SEM_CANAL, taskKind: "feature", exigirEm: ["feature"] }).action).toBe("none");
  });

  it("pending (turn-open and turn-not-completed) does not remprompt", () => {
    expect(consider({ judgment: PENDING_OPEN, taskKind: "feature", exigirEm: ["feature"] }).action).toBe("none");
    expect(consider({ judgment: PENDING_DEAD, taskKind: "feature", exigirEm: ["feature"] }).action).toBe("none");
  });

  it("com-plano does not remprompt", () => {
    expect(consider({ judgment: COM_PLANO, taskKind: "feature", exigirEm: ["feature"] }).action).toBe("none");
  });

  it("a task whose kind is not required does not remprompt", () => {
    expect(consider({ taskKind: "chore", exigirEm: ["feature"] }).action).toBe("none");
  });

  it("this suite calls the production door, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/internalPlanReprompt.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/internalPlanReprompt\.js"/);
    expect(source).toMatch(/considerInternalPlanReprompt\(/);
    expect(source).not.toMatch(/function considerInternalPlanReprompt\(/);
  });

  it("Workspace and the monitor call the production door", () => {
    const workspace = fs.readFileSync(path.resolve("packages/engine/src/workspace/Workspace.ts"), "utf8");
    const monitor = fs.readFileSync(
      path.resolve("packages/engine/src/workspace/InternalPlanRepromptMonitor.ts"),
      "utf8",
    );
    expect(monitor).toMatch(/from "\.\.\/runtime\/internalPlanReprompt\.js"/);
    expect(monitor).toMatch(/considerInternalPlanReprompt\(/);
    expect(monitor).not.toMatch(/function considerInternalPlanReprompt\(/);
    expect(workspace).toMatch(/internalPlanReprompt\.tick\(/);
  });
});
