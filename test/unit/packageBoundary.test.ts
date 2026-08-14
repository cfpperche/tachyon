import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(engineDependencies?: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "tachyon-package-boundary-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/engine/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/webview-ui/src"), { recursive: true });
  mkdirSync(path.join(root, "apps/shell/src"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"private":true,"workspaces":["apps/*","packages/*"]}\n');
  writeFileSync(path.join(root, "packages/engine/package.json"), `${JSON.stringify({ name: "@tachyon/engine", dependencies: engineDependencies })}\n`);
  writeFileSync(path.join(root, "packages/webview-ui/package.json"), '{"name":"@tachyon/webview-ui"}\n');
  writeFileSync(path.join(root, "apps/shell/package.json"), '{"name":"shell"}\n');
  writeFileSync(path.join(root, "packages/webview-ui/src/view.ts"), "export const view = true;\n");
  return root;
}

function runGate(root: string) {
  return execFileSync(process.execPath, [
    path.resolve("scripts/check-package-boundary.mjs"),
    "--root",
    root,
  ], { encoding: "utf8", stdio: "pipe" });
}

describe("package boundary gate", () => {
  it("fails when a relative import crosses from one package into another", () => {
    const root = fixture();
    writeFileSync(path.join(root, "packages/engine/src/index.ts"), 'import "../../webview-ui/src/view.js";\n');

    expect(() => runGate(root)).toThrowError(/outside packages\/engine/);
  });

  it("fails when a relative import escapes the root of an app", () => {
    const root = fixture();
    writeFileSync(path.join(root, "apps/shell/src/index.ts"), 'import "../../../packages/webview-ui/src/view.js";\n');

    expect(() => runGate(root)).toThrowError(/outside apps\/shell/);
  });

  it("fails when a named workspace import has no declared dependency", () => {
    const root = fixture();
    writeFileSync(path.join(root, "packages/engine/src/index.ts"), 'import "@tachyon/webview-ui/view.js";\n');

    expect(() => runGate(root)).toThrowError(/workspace dependency @tachyon\/webview-ui is not declared/);
  });

  it("accepts a named workspace import when the dependency is declared", () => {
    const root = fixture({ "@tachyon/webview-ui": "0.91.0" });
    writeFileSync(path.join(root, "packages/engine/src/index.ts"), 'import "@tachyon/webview-ui/view.js";\n');

    expect(runGate(root)).toMatch(/package boundary: ok/);
  });
});
