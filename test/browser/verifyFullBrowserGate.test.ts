import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The production runner is plain ESM and intentionally has no declaration surface.
// @ts-expect-error -- this test exercises the owned gate decision directly.
import { browserGateDecision } from "../../scripts/verify-full.mjs";

const roots: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-browser-gate-"));
  roots.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "browser-gate@example.invalid"]);
  git(cwd, ["config", "user.name", "Browser Gate"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "base\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["switch", "-c", "change"]);
  return cwd;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("verify:full conditional browser gate (t-6e929b)", () => {
  it("skips, visibly, when the diff does not touch src/webview", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "README.md"), "non-webview change\n");

    expect(browserGateDecision({ cwd })).toMatchObject({ run: false, webviewPaths: [] });
  });

  it("runs when a tracked or untracked diff touches src/webview", () => {
    const cwd = repo();
    fs.mkdirSync(path.join(cwd, "src", "webview"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "webview", "App.tsx"), "export {};\n");

    expect(browserGateDecision({ cwd })).toMatchObject({
      run: true,
      webviewPaths: ["src/webview/App.tsx"],
    });
  });
});
