import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("workspace script runner", () => {
  it("runs the target's exported main function", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-workspace-runner-"));
    fixtures.push(fixture);
    const target = path.join(fixture, "main.mjs");
    fs.writeFileSync(target, 'export async function main() { process.stdout.write("main-ran\\n"); return 7; }\n');

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-workspace-script.mjs"), target],
      { cwd: fixture, encoding: "utf8" },
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("main-ran\n");
  });

  it("turns an unresolved @tachyon package into an npm install instruction", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-workspace-runner-"));
    fixtures.push(fixture);
    const target = path.join(fixture, "missing-workspace.mjs");
    fs.writeFileSync(target, 'import "@tachyon/not-installed";\n');

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/run-workspace-script.mjs"), target],
      { cwd: fixture, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run `npm install`, then retry");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
