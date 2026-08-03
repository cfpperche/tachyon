import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * t-46eb4f — Control has exactly ONE global workspace/root selector, it lives in Overview, and it is
 * always visible. Everything else that says "workspace" on screen is a filter over the collection
 * that screen is already showing — those stay, and they never touch the global scope.
 *
 * The inventory is asserted over source because these are client-side controls in a codebase with no
 * DOM harness for Control (same tolerant-source-scan pattern cockpitFullpageSubrouteChrome.test.ts
 * uses); the host-side half of the contract — one writer of `controlWsHash` — is asserted the same
 * way, then exercised for real by the router/board suites.
 */
const WEBVIEW = path.resolve(__dirname, "..", "..", "src", "webview");

function webviewSources(dir = WEBVIEW): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return webviewSources(full);
    return entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) ? [full] : [];
  });
}

const sidebarApp = readFileSync(path.join(WEBVIEW, "sidebar", "App.tsx"), "utf8");

describe("the global workspace scope has exactly one control (SDD 485 C6)", () => {
  it("only the sidebar renders it, in Control's sec-actions slot", () => {
    const owners = webviewSources().filter((file) => readFileSync(file, "utf8").includes('data-testid="control-workspace-select"'));
    expect(owners.map((f) => path.relative(WEBVIEW, f))).toEqual(["sidebar/App.tsx"]);

    const controlHeader = /tab === "Control"[\s\S]*?<span class="sec-actions">[\s\S]*?<\/span>/.exec(sidebarApp)?.[0] ?? "";
    expect(controlHeader).toContain('data-testid="control-workspace-select"');
  });

  it("does not turn a single project into selector noise", () => {
    expect(sidebarApp).toMatch(/tab === "Control" && fleets\.length > 1/);
  });

  it("no screen mirrors it — the Board's own workspace dropdown is gone", () => {
    for (const file of webviewSources()) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(WEBVIEW, file)).not.toContain('data-testid="board-workspace-select"');
      expect(src, path.relative(WEBVIEW, file)).not.toContain('aria-label="Board workspace"');
    }
    // …and so is the action it posted, so no other client can re-target the global scope.
    const boardMessages = readFileSync(path.join(WEBVIEW, "mission-control", "messages.ts"), "utf8");
    expect(boardMessages).not.toContain("switchWorkspace");
  });

  it("the host authority is the window store, not Cockpit module state", () => {
    const host = readFileSync(path.join(WEBVIEW, "Cockpit.ts"), "utf8");
    const sidebarHost = readFileSync(path.join(WEBVIEW, "SidebarPrototype.ts"), "utf8");
    expect(sidebarHost).toMatch(/m\?\.type === "switchControlWorkspace"[\s\S]*?controlWorkspaceScope\.set\(hash\)/);
    expect(host).not.toContain("let controlWsHash");
    expect(host).toContain("controlWorkspaceScope.current");
  });
});

describe("local filters are not global selectors (t-46eb4f)", () => {
  it("tmux keeps its Workspace filter — its universe includes closed and other-workspace sessions", () => {
    const inspector = readFileSync(path.join(WEBVIEW, "inspector", "App.tsx"), "utf8");
    // A client-side filter over the rows already on screen…
    expect(inspector).toContain('const [workspace, setWorkspace] = useState("all")');
    expect(inspector).toMatch(/workspace !== "all" && \(group\.wsHash \?\? "unscoped"\) !== workspace/);
    // …that posts nothing: it cannot move the global scope.
    expect(inspector).not.toContain("switchControlWorkspace");
    expect(inspector).not.toContain("switchWorkspace");
  });

  it("the Board keeps the filters that only narrow its own cards", () => {
    const board = readFileSync(path.join(WEBVIEW, "mission-control", "App.tsx"), "utf8");
    expect(board).toContain('aria-label="Search tasks"');
    expect(board).toContain("All agents");
    expect(board).not.toContain("switchControlWorkspace");
  });
});
