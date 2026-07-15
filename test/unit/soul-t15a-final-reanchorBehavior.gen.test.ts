import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("spec 377 T15A transaction recovery and Studio trust closure", () => {
    expect(() => execFileSync(
      "npx",
      ["vitest", "run", "test/unit/soul-t15a-correctionsBehavior.gen.test.ts"],
      { cwd: process.cwd(), stdio: "pipe" },
    )).not.toThrow();
  }, 120_000);
});
