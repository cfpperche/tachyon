import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("container-generated delegation behavior", () => {
  it("cmd:npm run typecheck", () => {
    expect(() => execFileSync("npm", ["run", "typecheck"], { cwd: process.cwd(), stdio: "pipe" })).not.toThrow();
  }, 60_000);
});
