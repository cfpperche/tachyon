import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("container-generated delegation behavior", () => {
  it("cmd:npx vitest run test/unit/soul-profile-t15a-implBehavior.gen.test.ts", () => {
    expect(() => execFileSync(
      "npx",
      ["vitest", "run", "test/unit/soul-profile-t15a-implBehavior.gen.test.ts"],
      { cwd: process.cwd(), stdio: "pipe" },
    )).not.toThrow();
  }, 120_000);
});
