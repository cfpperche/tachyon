import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const src = readFileSync(path.join(root, "packages/webview-ui/src/webview/agent-studio-shell/App.tsx"), "utf8");

/**
 * t-eaffa5 — the three Lifecycle confirmations must be KitDialog, not a second in-flow panel.
 * A source tripwire: the rendered-document proof lives in the browser suite.
 */
describe("t-eaffa5 Agent Studio lifecycle confirmations are KitDialog", () => {
  it("Rename, Forget and Clone/Import render through KitDialog", () => {
    expect(src).toContain("<KitDialog");
    expect(src).toContain('data-testid="ash-rename-dialog"');
    expect(src).toContain('data-testid="ash-forget-dialog"');
    expect(src).toContain('data-testid="ash-bundle-dialog"');
  });

  it("does not keep the old in-flow confirm wrappers", () => {
    expect(src).not.toContain('class="ash-profile-replace-confirm"');
    expect(src).not.toContain('class="ash-profile-delete-confirm"');
  });
});
