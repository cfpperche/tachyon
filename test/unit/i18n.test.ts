import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../helpers/repositorySourceScan.js";

/**
 * Product language is English (t-92bf17). `vscode.l10n.t()` calls stay — they are how VS Code does
 * strings, not a cost of the removed pt-BR bundles. Contribution titles live in package.nls.json.
 *
 * There is no translation bundle and no completeness gate. Do not invent one while there is nothing
 * to translate (t-e0df58 closed for that).
 *
 * When translation returns, regex extraction of `l10n.t("...")` is BLIND to 304 strings that pass
 * through an alias `const t = vscode.l10n.t`:
 *   apps/vscode-extension/src/webview/controlStrings.ts:5         129
 *   apps/vscode-extension/src/webview/WorktreesPanel.ts:278        83
 *   apps/vscode-extension/src/webview/TmuxPanel.ts:262             54
 *   apps/vscode-extension/src/webview/RuntimeConfigPanel.ts:137    38
 * See apps/vscode-extension/l10n/README.md.
 */

const root = path.resolve(__dirname, "../..");

describe("i18n completeness", () => {
  it("every %key% in package.json exists in package.nls.json", () => {
    const pkg = fs.readFileSync(path.join(workspaceRoot("tachyon"), "package.json"), "utf8");
    const refs = [...pkg.matchAll(/%([a-zA-Z0-9._-]+)%/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    const en = JSON.parse(fs.readFileSync(path.join(root, "apps/vscode-extension/package.nls.json"), "utf8"));
    expect(refs.filter((r) => !(r in en))).toEqual([]);
  });
});
