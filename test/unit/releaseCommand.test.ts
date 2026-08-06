import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("release command", () => {
  it("t-c767fc: leaves no npm packaging door that invokes vsce without the release guard", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.release).toBe("node scripts/release.mjs");
    expect(manifest.scripts.package).toBe(manifest.scripts.release);
    expect(manifest.scripts["package:assert"]).toBe("node scripts/prepare-package.mjs");
    expect(manifest.scripts["package:prepare"]).toBeUndefined();
    expect(manifest.scripts["vscode:prepublish"]).toBe("npm run package:assert");
    expect(Object.values(manifest.scripts).join("\n")).not.toMatch(/(?:^|\s)vsce\s+package(?:\s|$)/m);
  });

  it("runs stable build, assertion, packaging, and smoke in order", async () => {
    const { runRelease } = await import("../../scripts/release.mjs");
    const calls: Array<[string, string[]]> = [];

    runRelease({
      args: ["--out", "tachyon.vsix"],
      run(command, args) {
        calls.push([command, args]);
      },
    });

    expect(calls).toEqual([
      ["npm", ["run", "build:stable"]],
      ["npm", ["run", "package:assert"]],
      ["vsce", ["package", "--out", "tachyon.vsix"]],
      ["npm", ["run", "smoke:vsix"]],
    ]);
  });

  it("cannot reach vsce or smoke after a failed precondition", async () => {
    const { runRelease } = await import("../../scripts/release.mjs");
    const calls: string[] = [];

    expect(() => runRelease({
      run(command, args) {
        const invocation = [command, ...args].join(" ");
        calls.push(invocation);
        if (invocation === "npm run package:assert") throw new Error("refused dev manifest");
      },
    })).toThrow("refused dev manifest");

    expect(calls).toEqual(["npm run build:stable", "npm run package:assert"]);
  });
});
