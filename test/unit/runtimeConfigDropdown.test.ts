import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("Runtime Config runtime dropdown", () => {
  it("uses the accessible Kit dropdown with canonical runtime logos", () => {
    const source = fs.readFileSync(path.join(root, "src/webview/cockpit/App.tsx"), "utf8");
    const start = source.indexOf("function RuntimeConfigInventory");
    const end = source.indexOf("\\nfunction ", start + 1);
    const inventory = source.slice(start, end < 0 ? undefined : end);

    expect(inventory).toContain("<KitDropdown>");
    expect(inventory).toContain('data-testid="runtime-config-runtime-trigger"');
    expect(inventory).toContain("<RuntimeLogo id={activeRuntime.runtime} />");
    expect(inventory).toContain("<RuntimeLogo id={candidate.runtime} />");
    expect(inventory).toContain("setRuntimeId(candidate.runtime)");
    expect(inventory).toContain('setDocumentId(candidate.documents[0]?.id ?? "")');
  });

  it("keeps the scope selector segmented and scopes menu styling to Runtime Config", () => {
    const source = fs.readFileSync(path.join(root, "src/webview/cockpit/App.tsx"), "utf8");
    const styles = fs.readFileSync(path.join(root, "src/webview/cockpit/cockpit.css"), "utf8");

    expect(source).toContain('<div class="rcp-segmented" role="group" aria-label={s.runtimeConfigScope}>');
    expect(styles).toContain('.rcp-runtime-menu[data-slot="dropdown-menu-content"]');
    expect(styles).toContain('.rcp-runtime-option[data-slot="dropdown-menu-item"][data-highlighted]');
    expect(styles).toContain(".rcp-runtime-logo .ash-runtime-logo");
  });
});
