import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("t-77097d — Onboarding replaces the native VS Code walkthrough", () => {
  it("removes the retired walkthrough contribution and command", () => {
    const manifest = JSON.parse(read("apps/vscode-extension/package.json")) as {
      contributes: { commands: Array<{ command: string }>; walkthroughs?: unknown };
    };
    const extension = read("apps/vscode-extension/src/extension.ts");

    expect(manifest.contributes.walkthroughs).toBeUndefined();
    expect(manifest.contributes.commands.map(({ command }) => command)).not.toContain("tachyon.getStarted");
    expect(extension).not.toContain('registerCommand("tachyon.getStarted"');
    expect(extension).not.toContain("workbench.action.openWalkthrough");
  });

  it("keeps a clean install connected to the first-agent door through Onboarding", () => {
    const sidebarApp = read("packages/webview-ui/src/webview/sidebar/App.tsx");
    const sidebarHost = read("apps/vscode-extension/src/webview/SidebarPrototype.ts");
    const extension = read("apps/vscode-extension/src/extension.ts");
    const onboardingPanel = read("apps/vscode-extension/src/webview/OnboardingPanel.ts");

    expect(sidebarApp).toContain('data-testid="sidebar-boot-unconfigured"');
    expect(sidebarApp).toContain('dispatch?.global("onboarding")');
    expect(sidebarHost).toContain('m.op === "onboarding"');
    expect(sidebarHost).toContain('executeCommand("tachyon.openOnboarding")');
    expect(extension).toContain('registerCommand("tachyon.openOnboarding"');
    expect(onboardingPanel).toContain('action.type === "openAgentStudio"');
    expect(onboardingPanel).toContain("this.deps.openNewAgentStudio()");
  });
});
