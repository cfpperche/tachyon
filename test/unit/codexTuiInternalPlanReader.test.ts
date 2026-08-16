import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexInternalPlan } from "@tachyon/engine/runtime/codexInternalPlanReader.js";
import {
  codexTuiPlanNotifications,
  readCodexTuiInternalPlan,
} from "@tachyon/engine/runtime/codexTuiInternalPlanReader.js";
import { CODEX_INTERNAL_PLAN_NOTIFICATION } from "@tachyon/engine/runtime/codexInternalPlanReader.js";

/**
 * t-281339 — the TUI ledger is adapted into `turn/plan/updated` and handed
 * to `readCodexInternalPlan`. A helper that projects the plan itself, or
 * that never calls the production reader, turns this file red.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeLedger(rows: readonly unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-tui-plan-"));
  dirs.push(root);
  const file = path.join(root, ".tachyon", "activity", "codex-tool-hooks.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return root;
}

const PLAN = [
  { step: "Boil water", status: "completed" },
  { step: "Steep the tea", status: "inProgress" },
  { step: "Serve the tea", status: "pending" },
];

describe("t-281339 — readCodexTuiInternalPlan consumes readCodexInternalPlan", () => {
  it("projects the last update_plan toolInput through the production reader", () => {
    const root = writeLedger([
      { agent: "coder", toolName: "Bash", toolInput: { command: "ls" } },
      { agent: "coder", toolName: "update_plan", toolInput: { plan: [{ step: "old", status: "pending" }] } },
      { agent: "other", toolName: "update_plan", toolInput: { plan: [{ step: "not mine", status: "pending" }] } },
      { agent: "coder", toolName: "update_plan", toolInput: { plan: PLAN } },
    ]);
    const plan = readCodexTuiInternalPlan(root, "coder");
    expect(plan).toEqual({
      state: "snapshot",
      items: [
        { texto: "Boil water", status: "completed" },
        { texto: "Steep the tea", status: "in-progress" },
        { texto: "Serve the tea", status: "pending" },
      ],
    });
    const viaDoor = readCodexInternalPlan({ notifications: codexTuiPlanNotifications(root, "coder") });
    expect(viaDoor).toEqual(plan);
  });

  it("is mute when the ledger never spoke a plan", () => {
    const root = writeLedger([{ agent: "coder", toolName: "Bash", toolInput: { command: "ls" } }]);
    expect(readCodexTuiInternalPlan(root, "coder")).toEqual({ state: "mute" });
    expect(readCodexTuiInternalPlan(root, "nobody")).toEqual({ state: "mute" });
  });

  it("shapes notifications as turn/plan/updated — the production door", () => {
    const root = writeLedger([
      { agent: "coder", toolName: "update_plan", toolInput: { plan: [{ step: "only", status: "pending" }] } },
    ]);
    const notes = codexTuiPlanNotifications(root, "coder");
    expect(notes).toEqual([
      { method: CODEX_INTERNAL_PLAN_NOTIFICATION, params: { plan: [{ step: "only", status: "pending" }] } },
    ]);
  });

  it("this suite calls the production reader, not a stand-in", () => {
    const source = fs.readFileSync(path.resolve("packages/engine/src/runtime/codexTuiInternalPlanReader.ts"), "utf8");
    expect(source).toMatch(/from "\.\/codexInternalPlanReader\.js"/);
    expect(source).toMatch(/readCodexInternalPlan\(/);
    expect(source).not.toMatch(/function readCodexInternalPlan\(/);
  });
});
