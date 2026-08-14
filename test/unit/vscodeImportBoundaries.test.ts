import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- repository scripts are plain ESM without declaration files.
import { checkVscodeImportBoundaries } from "../../scripts/check-vscode-import-boundaries.mjs";

const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vscode-boundary-"));
  temporaryRoots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("vscode import boundaries", () => {
  it("keeps the current tree green with one live root shell entry", () => {
    expect(checkVscodeImportBoundaries(process.cwd())).toEqual({ offenders: [], staleAllowEntries: [] });
  });

  it("fails a shell allowlist entry that matches zero files", () => {
    const root = fixture({ "src/webview/live.ts": "export const live = true;\n" });
    const result = checkVscodeImportBoundaries(root, [
      { prefix: "src/webview/", reason: "live fixture shell" },
      { prefix: "src/presentation/", reason: "stale migrated shell address" },
    ]);
    expect(result.staleAllowEntries.map((entry: { prefix: string }) => entry.prefix)).toEqual(["src/presentation/"]);
  });

  it("rejects both value and type-only vscode imports from webview-ui", () => {
    const root = fixture({
      "src/webview/live.ts": "export const live = true;\n",
      "packages/webview-ui/src/value.ts": 'import * as vscode from "vscode";\nvoid vscode;\n',
      "packages/webview-ui/src/type.ts": 'import type * as vscode from "vscode";\nexport type Uri = vscode.Uri;\n',
    });
    expect(checkVscodeImportBoundaries(root).offenders).toEqual([
      { file: "packages/webview-ui/src/type.ts", kinds: ["type"] },
      { file: "packages/webview-ui/src/value.ts", kinds: ["value"] },
    ]);
  });

  it("retains zero tolerance in engine while allowing the live root webview shell", () => {
    const root = fixture({
      "src/webview/live.ts": 'import * as vscode from "vscode";\nvoid vscode;\n',
      "packages/engine/src/bad.ts": 'type Uri = import("vscode").Uri;\nexport type { Uri };\n',
    });
    expect(checkVscodeImportBoundaries(root).offenders).toEqual([
      { file: "packages/engine/src/bad.ts", kinds: ["type"] },
    ]);
  });
});
