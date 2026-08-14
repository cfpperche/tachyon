import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent Instance lineage inventory (t-d542ac)", () => {
  it("has no legacy stripDeclaredParent symbol or storage-origin parent gate", () => {
    const ledger = fs.readFileSync(path.resolve("packages/engine/src/resume/SessionLedger.ts"), "utf8");
    const manager = fs.readFileSync(path.resolve("packages/engine/src/agents/AgentManager.ts"), "utf8");

    expect(ledger).not.toContain("stripDeclaredParent");
    expect(manager).not.toMatch(/const parent\s*=\s*adhoc\s*&&/);
  });
});
