import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-e1bd89 — Cockpit co-loads approval.css with mission-control.css. An unscoped
 * `button { background: vscode-button-background }` paints every Mission board chip blue.
 */
describe("approval.css surface scoping (t-e1bd89)", () => {
  const cssPath = path.resolve(__dirname, "../../src/webview/approval/approval.css");
  const css = fs.readFileSync(cssPath, "utf8");

  it("does not declare a bare global button rule", () => {
    // Match `button {` at start of a line (allow leading whitespace), not `.approval-root button`.
    const bare = /^\s*button\s*\{/m.test(css);
    const bareHover = /^\s*button:hover/m.test(css);
    expect(bare).toBe(false);
    expect(bareHover).toBe(false);
  });

  it("scopes primary button chrome under .approval-root", () => {
    expect(css).toMatch(/\.approval-root\s+button\s*\{/);
    expect(css).toMatch(/\.approval-root\s+button:hover/);
  });
});
