import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

describe("host-action core architecture", () => {
  it("keeps packages/engine/src/host-action host-neutral", async () => {
    const files = await listTsFiles("packages/engine/src/host-action");
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
      expect(source, file).not.toMatch(/\bexecuteCommand\b/);
      expect(source, file).not.toMatch(/\bworkbench\.[A-Za-z0-9_.-]+/);
      expect(source, file).not.toMatch(/\b(vscode|Uri|Position|Range|TextEditor|WorkspaceFolder|ExtensionContext)\b/);
    }
  });
});

async function listTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listTsFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return files.flat().sort();
}
