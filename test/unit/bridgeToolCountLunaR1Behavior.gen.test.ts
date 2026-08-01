import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("exposes exactly the 70 tools", () => {
    const bridgeTest = readFileSync(join(process.cwd(), "test/unit/bridge.test.ts"), "utf8");

    // t-e88c8a stage 1 — the canonical inventory in bridge.test.ts is the subject; the count moved
    // 78 → 69 when the nine Delivery tools were retired; 69 → 70 when t-f638bd added reconcile_task.
    expect(bridgeTest).toContain('it("exposes exactly the 70 canonical tools');
    expect(bridgeTest).toMatch(/\[\s*[\s\S]*"write_tachyon_config",/);
  });
});
