import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-7b4bb5 — Control → Settings must name the two authorities (global personal file vs
 * workspace tachyon.yml) without VS Code settings folklore or ambiguous open labels.
 */

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("t-7b4bb5 — Settings scope copy", () => {
  it("host strings no longer send people to VS Code Settings UI", () => {
    const host = read("src/webview/Cockpit.ts");
    expect(host).toContain('t("Open global settings")');
    expect(host).toContain('t("Open workspace settings")');
    expect(host).not.toMatch(/VS Code Settings UI/);
    expect(host).toContain("settingsScopeGlobalTitle");
    expect(host).toContain("settingsScopeWorkspaceTitle");
  });

  it("Settings surface renders dual-scope cards with paths and open actions", () => {
    const app = read("src/webview/cockpit/App.tsx");
    expect(app).toContain('data-testid="control-settings-scopes"');
    expect(app).toContain('data-testid="control-settings-scope-global"');
    expect(app).toContain('data-testid="control-settings-scope-workspace"');
    expect(app).toContain('data-testid="control-settings-global-path"');
    expect(app).toContain('data-testid="control-settings-workspace-path"');
    expect(app).toContain("tachyon.yml");
    // Ambiguous side-by-side jump of both opens is gone; opens live inside the scope cards.
    expect(app).toContain('data-testid="control-settings-open-global"');
    expect(app).toContain('data-testid="control-settings-open-workspace"');
    const settingsSection = app.slice(app.indexOf('data-testid="control-settings"'));
    expect(settingsSection.includes('class="ck-jump"')).toBe(false);
  });

  it("CSS keeps paths wrapping and stacks scopes on narrow viewports", () => {
    const css = read("src/webview/cockpit/cockpit.css");
    expect(css).toContain(".ck-settings-scopes");
    expect(css).toContain("grid-template-columns: 1fr 1fr");
    expect(css).toMatch(/@media \(max-width:\s*720px\)[\s\S]*\.ck-settings-scopes[\s\S]*grid-template-columns:\s*1fr/);
    expect(css).toContain(".ck-settings-path");
    expect(css).toMatch(/\.ck-settings-path[\s\S]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.ck-settings-path[\s\S]*word-break:\s*break-all/);
  });
});
