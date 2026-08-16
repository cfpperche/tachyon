import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeCodexInternalChecklistTurn } from "@tachyon/engine/runtime/codexInternalChecklistTurn.js";
import { readCodexTurnEvidence } from "@tachyon/engine/runtime/codexTurnEvidence.js";

/**
 * t-73885b — evidence for the existing Codex judge. These tests call
 * `judgeCodexInternalChecklistTurn` with rows gathered from the TUI hook
 * ledgers. A helper that returns `absent` from Stop-without-turn_id
 * turns the suite red.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-evidence-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, ".tachyon", "activity"), { recursive: true });
  return root;
}

function writeJsonl(root: string, file: string, rows: unknown[]): void {
  fs.writeFileSync(
    path.join(root, ".tachyon", "activity", file),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
    "utf8",
  );
}

describe("t-73885b — readCodexTurnEvidence feeds the production judge", () => {
  it("emits absent for a Stop with turn_id and no update_plan", () => {
    const root = workspace();
    writeJsonl(root, "persistence-stop.jsonl", [
      { agent: "worker", event: "Stop", turnId: "turn-1", sessionId: "s1", ts: "2026-08-16T18:00:00.000Z" },
    ]);
    const evidence = readCodexTurnEvidence(root, "worker");
    expect(evidence).toBeDefined();
    expect(judgeCodexInternalChecklistTurn(evidence!)).toEqual({ state: "verdict", verdict: "absent" });
  });

  it("emits present when update_plan was recorded for the same turn", () => {
    const root = workspace();
    writeJsonl(root, "persistence-stop.jsonl", [
      { agent: "worker", event: "Stop", turnId: "turn-2", sessionId: "s1", ts: "2026-08-16T18:00:00.000Z" },
    ]);
    writeJsonl(root, "codex-tool-hooks.jsonl", [
      { agent: "worker", event: "PostToolUse", toolName: "update_plan", turnId: "turn-2" },
    ]);
    const evidence = readCodexTurnEvidence(root, "worker");
    expect(judgeCodexInternalChecklistTurn(evidence!)).toEqual({ state: "verdict", verdict: "present" });
  });

  it("does not invent absent from a Stop that dropped turn_id", () => {
    const root = workspace();
    writeJsonl(root, "persistence-stop.jsonl", [
      { agent: "worker", event: "Stop", sessionId: "s1", ts: "2026-08-16T18:00:00.000Z" },
    ]);
    expect(readCodexTurnEvidence(root, "worker")).toBeUndefined();
  });

  it("this suite calls the production judge, not a test-local stand-in", () => {
    const source = fs.readFileSync(path.resolve("test/unit/codexTurnEvidence.test.ts"), "utf8");
    expect(source).toMatch(/from "@tachyon\/engine\/runtime\/codexInternalChecklistTurn\.js"/);
    expect(source).toMatch(/judgeCodexInternalChecklistTurn\(/);
    expect(source).not.toMatch(/function judgeCodexInternalChecklistTurn\(/);
  });
});
