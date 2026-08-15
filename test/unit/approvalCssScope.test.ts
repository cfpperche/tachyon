import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-e1bd89 — Cockpit co-loads approval.css with board.css. An unscoped
 * `button { background: vscode-button-background }` paints every Mission board chip blue.
 */
describe("approval.css surface scoping (t-e1bd89)", () => {
  const cssPath = path.resolve(__dirname, "../../packages/webview-ui/src/webview/approval/approval.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const appPath = path.resolve(__dirname, "../../packages/webview-ui/src/webview/approval/App.tsx");
  const app = fs.readFileSync(appPath, "utf8");

  it("does not declare a bare global button rule", () => {
    // Match `button {` at start of a line (allow leading whitespace), not `.approval-root button`.
    const bare = /^\s*button\s*\{/m.test(css);
    const bareHover = /^\s*button:hover/m.test(css);
    expect(bare).toBe(false);
    expect(bareHover).toBe(false);
  });

  it("uses the shared Button component without adding approval-local button chrome", () => {
    expect(app).toMatch(/import\s*{[^}]*\bButton\b[^}]*}\s*from\s*["']@tachyon\/webview-ui\/webview\/shared\/ui\/index["']/);
    expect(app).toMatch(/<Button\b/);
    expect(css).not.toMatch(/(?:^|[,{])\s*(?:\.approval-root\s+)?button(?=[:.\s,{])/m);
  });
});
