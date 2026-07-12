import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("container-generated delegation behavior", () => {
  it("cmd:grep -Eq Verdict .tachyon/studies/368-process-audit-helper-spike.md", () => {
    const report = readFileSync(
      `${process.cwd()}/.tachyon/studies/368-process-audit-helper-spike.md`,
      "utf8",
    );
    expect(report).toMatch(/Verdict/);
    expect(report).toContain("**BLOCKED.**");
    expect(report).toContain("7184effe63b01350ccf4b78ac3b58358971bc4e177eaf5acdc0e0df32c82a5b3");
    expect(report).toContain("ec388bda68d5e7959ea56797bcfa278955b85264106e5048ef414569fc80eba1");
    expect(report).toContain("CAP_SYS_PTRACE");
    expect(report).toContain("state=unknown");
  });
});
