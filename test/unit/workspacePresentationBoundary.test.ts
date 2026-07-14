import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("persistent workspace presentation boundary", () => {
  it("freezes every remaining concrete Workspace import in the shell and presentation", () => {
    const inventoryPath = path.join(
      root,
      "docs/specs/382-persistent-engine-shell-boundary/presentation-workspace-inventory.txt",
    );
    const expected = fs.readFileSync(inventoryPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .sort();
    const candidates = [
      path.join(root, "src/extension.ts"),
      ...walkTypeScript(path.join(root, "src/webview")),
      ...walkTypeScript(path.join(root, "src/plugins", "ui")),
      ...walkTypeScript(path.join(root, "src/runtimeOps")),
      ...walkTypeScript(path.join(root, "src/presentation")),
    ];
    const actual = candidates
      .filter((file) => /workspace\/Workspace\.js/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
    expect(actual).toEqual(expected);
  });

  it("keeps migrated panels off the concrete Workspace class", () => {
    const migrated = ["src/webview/ApprovalPanel.ts"];
    for (const relative of migrated) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/workspace\/Workspace(?:\.js)?/);
      expect(source, relative).toMatch(/WorkspacePresentationTarget/);
    }
  });

  it("keeps the runtime projection and deterministic client fake editor-free", () => {
    for (const relative of [
      "src/runtime-api/workspaceProjection.ts",
      "src/shell/FakeWorkspaceClient.ts",
      "src/shell/WorkspacePresentation.ts",
    ]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/from\s+["']vscode["']/);
    }
  });
});

function walkTypeScript(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(target);
  }
  return out;
}
