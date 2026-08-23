import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("container-generated delegation behavior", () => {
  it("cmd:grep -Eq PASS test/fixtures/studies/368-process-fence-cgroup-spike.md", () => {
    const report = readFileSync(
      `${process.cwd()}/test/fixtures/studies/368-process-fence-cgroup-spike.md`,
      "utf8",
    );
    expect(report).toContain("PASS");
  });
});
