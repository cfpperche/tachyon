import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("container-generated delegation behavior", () => {
  // Full-suite load (many vitest workers) can push a cold typecheck past 60s; alone it is ~35s.
  // Prefer a longer budget over a silent STACK_TRACE_ERROR when the child is still working.
  it("cmd:npm run typecheck", () => {
    expect(() => execFileSync("npm", ["run", "typecheck"], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    })).not.toThrow();
  }, 200_000);
});
