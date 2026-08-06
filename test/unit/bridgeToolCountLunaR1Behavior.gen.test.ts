import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("exposes exactly the 79 tools", () => {
    const bridgeTest = readFileSync(join(process.cwd(), "test/unit/bridge.test.ts"), "utf8");

    // t-e88c8a stage 1 — the canonical inventory in bridge.test.ts is the subject; the count moved
    // 78 → 69 when the nine Delivery tools were retired; 69 → 70 when t-f638bd added reconcile_task;
    // 70 → 71 when t-0bebf6 added acknowledge_agent; 71 → 72 when t-6f0377 added renew_context;
    // 72 → 75 when t-afe120 added the three Saved Agent removal-proposal tools;
    // 75 → 76 when t-458497 added runtime_condition; 76 → 77 when t-14cf7c added explicit
    // orphan runtime credential reconciliation; 77 → 76 when t-a4ac02 removed next_task;
    // 76 → 77 when t-75e9c7 added agent_touched_files; 77 → 78 when t-167b5c added read_notices
    // (spec 493, the durable read door onto .tachyon/doorbells.jsonl); 78 → 79 when t-1926ce added
    // read-only orphan process reporting for deleted managed worktrees.
    expect(bridgeTest).toContain('it("exposes exactly the 79 canonical tools');
    expect(bridgeTest).toMatch(/\[\s*[\s\S]*"write_tachyon_config",/);
  });
});
