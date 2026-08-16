import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexInternalChecklist } from "@tachyon/engine/runtime/codexInternalChecklistReader.js";
import {
  codexTuiChecklistNotifications,
  readCodexTuiInternalChecklist,
} from "@tachyon/engine/runtime/codexTuiInternalChecklistReader.js";
import { CODEX_INTERNAL_CHECKLIST_NOTIFICATION } from "@tachyon/engine/runtime/codexInternalChecklistReader.js";

/**
 * t-281339 — the TUI ledger is adapted into `turn/plan/updated` and handed
 * to `readCodexInternalChecklist`. A helper that projects the plan itself, or
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

describe("t-281339 — readCodexTuiInternalChecklist consumes readCodexInternalChecklist", () => {
  it("projects the last update_plan toolInput through the production reader", () => {
    const root = writeLedger([
      { agent: "coder", toolName: "Bash", toolInput: { command: "ls" } },
      { agent: "coder", toolName: "update_plan", toolInput: { plan: [{ step: "old", status: "pending" }] } },
      { agent: "other", toolName: "update_plan", toolInput: { plan: [{ step: "not mine", status: "pending" }] } },
      { agent: "coder", toolName: "update_plan", toolInput: { plan: PLAN } },
    ]);
    const plan = readCodexTuiInternalChecklist(root, "coder");
    expect(plan).toEqual({
      state: "snapshot",
      items: [
        { text: "Boil water", status: "completed" },
        { text: "Steep the tea", status: "in-progress" },
        { text: "Serve the tea", status: "pending" },
      ],
    });
    const viaDoor = readCodexInternalChecklist({ notifications: codexTuiChecklistNotifications(root, "coder") });
    expect(viaDoor).toEqual(plan);
  });

  it("is mute when the ledger never spoke a plan", () => {
    const root = writeLedger([{ agent: "coder", toolName: "Bash", toolInput: { command: "ls" } }]);
    expect(readCodexTuiInternalChecklist(root, "coder")).toEqual({ state: "mute" });
    expect(readCodexTuiInternalChecklist(root, "nobody")).toEqual({ state: "mute" });
  });

  it("shapes notifications as turn/plan/updated — the production door", () => {
    const root = writeLedger([
      { agent: "coder", toolName: "update_plan", toolInput: { plan: [{ step: "only", status: "pending" }] } },
    ]);
    const notes = codexTuiChecklistNotifications(root, "coder");
    expect(notes).toEqual([
      { method: CODEX_INTERNAL_CHECKLIST_NOTIFICATION, params: { plan: [{ step: "only", status: "pending" }] } },
    ]);
  });

  it("this suite calls the production reader, not a stand-in", () => {
    const source = fs.readFileSync(path.resolve("packages/engine/src/runtime/codexTuiInternalChecklistReader.ts"), "utf8");
    expect(source).toMatch(/from "\.\/codexInternalChecklistReader\.js"/);
    expect(source).toMatch(/readCodexInternalChecklist\(/);
    expect(source).not.toMatch(/function readCodexInternalChecklist\(/);
  });
});
