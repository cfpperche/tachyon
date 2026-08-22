import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-7b4bb5 — Control → Settings must name the two authorities (global personal file vs
 * workspace .tachyon/settings.yml) without VS Code settings folklore or ambiguous open labels.
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("t-7b4bb5 — Settings scope copy", () => {
  it("host strings no longer send people to VS Code Settings UI", () => {
    const host = read("apps/vscode-extension/src/webview/controlStrings.ts");
    expect(host).toContain('t("Open global settings")');
    expect(host).toContain('t("Open workspace settings")');
    expect(host).not.toMatch(/VS Code Settings UI/);
    expect(host).toContain("settingsScopeGlobalTitle");
    expect(host).toContain("settingsScopeWorkspaceTitle");
  });

  it("Settings surface renders dual-scope cards with paths and open actions", () => {
    const app = read("packages/webview-ui/src/webview/settings/main.tsx");
    expect(app).toContain('data-testid="control-settings-scopes"');
    expect(app).toContain('data-testid="control-settings-scope-global"');
    expect(app).toContain('data-testid="control-settings-scope-workspace"');
    expect(app).toContain('data-testid="control-settings-global-path"');
    expect(app).toContain('data-testid="control-settings-workspace-path"');
    expect(app).toContain(".tachyon/settings.yml");
    // Ambiguous side-by-side jump of both opens is gone; opens live inside the scope cards.
    expect(app).toContain('data-testid="control-settings-open-global"');
    expect(app).toContain('data-testid="control-settings-open-workspace"');
    const settingsSection = app.slice(app.indexOf('data-testid="control-settings"'));
    expect(settingsSection.includes('class="ck-jump"')).toBe(false);
  });

  it("CSS keeps paths wrapping and stacks scopes on narrow viewports", () => {
    const css = read("packages/webview-ui/src/webview/settings/settings.css");
    expect(css).toContain(".ck-settings-scopes");
    expect(css).toContain("grid-template-columns: 1fr 1fr");
    expect(css).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.ck-settings-scopes[\s\S]*grid-template-columns:\s*1fr/);
    expect(css).toContain(".ck-settings-path");
    expect(css).toMatch(/\.ck-settings-path[\s\S]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.ck-settings-path[\s\S]*word-break:\s*break-all/);
  });

  it("t-2ad294 — four Settings paragraphs state the split; teaching-the-model sentences are gone", () => {
    const host = read("apps/vscode-extension/src/webview/controlStrings.ts");
    expect(host).toContain("settingsBody");
    expect(host).toContain("settingsScopeGlobalHint");
    expect(host).toContain("settingsScopeWorkspaceHint");
    expect(host).toContain("globalSettingsHint");
    expect(host).toContain("Two settings files, on purpose");
    expect(host).toContain("Your machine preferences — agent pane, git path, theme.");
    expect(host).toContain("Shared project policy in .tachyon/settings.yml — versioned with the repo.");
    expect(host).toContain("Per-person, per-machine, in a plain file you can edit by hand.");
    expect(host).not.toMatch(/they are not two places for the same list/i);
    expect(host).not.toMatch(/recovery path when Control/i);
    expect(host).not.toMatch(/agent limit, memory cap/);
  });

  it("offers the font choice on the global block and does not send it through VS Code settings", () => {
    const app = read("packages/webview-ui/src/webview/settings/main.tsx");
    expect(app).toContain('data-testid="global-settings-font"');
    expect(app).toContain('value="departure"');
    expect(app).toContain("applyTachyonFont");
    const host = read("apps/vscode-extension/src/webview/controlStrings.ts");
    expect(host).toContain('t("UI font")');
    expect(host).toContain("this page updates now");
    const pane = read("apps/vscode-extension/src/webview/AgentPanePanel.ts");
    expect(pane).not.toContain("shellTachyonFont");
    expect(pane).not.toContain("tachyonFont");
  });
});
