import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("plural app workspace discovery", () => {
  it("discovers a second apps/* workspace without changing the resolver", async () => {
    const { extensionWorkspace, workspaceManifests } = await import("../../scripts/workspace-layout.mjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-app-workspaces-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "apps", "shell"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps", "another-app"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    fs.writeFileSync(path.join(root, "apps", "shell", "package.json"), JSON.stringify({ name: "shell", engines: { vscode: "^1" } }));
    fs.writeFileSync(path.join(root, "apps", "another-app", "package.json"), JSON.stringify({ name: "another-app" }));

    expect(workspaceManifests(root).map(({ manifest }) => manifest.name)).toEqual(["another-app", "shell"]);
    expect(extensionWorkspace(root).manifest.name).toBe("shell");
  });
});
