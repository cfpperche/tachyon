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

const cockpitApp = readFileSync(path.join(WEBVIEW, "cockpit", "App.tsx"), "utf8");

describe("the global workspace scope has exactly one control (t-46eb4f)", () => {
  it("only Overview renders it, and nothing else in the webview does", () => {
    const owners = webviewSources().filter((file) => readFileSync(file, "utf8").includes('data-testid="control-workspace-select"'));
    expect(owners.map((f) => path.relative(WEBVIEW, f))).toEqual(["cockpit/App.tsx"]);

    // It sits in Overview's own actions row — not in the nav chrome, where a second one used to live.
    const overviewActions = /<div class="ck-overview-actions">[\s\S]*?<\/div>\s*\}/.exec(cockpitApp)?.[0] ?? "";
    expect(overviewActions).toContain('data-testid="control-workspace-select"');
    const navChrome = cockpitApp.slice(cockpitApp.indexOf('role="tab"'));
    expect(navChrome).not.toContain('data-testid="control-workspace-select"');
  });

  it("is rendered unconditionally — a single root still shows which root it is", () => {
    // The retired header copy was gated on `m.workspaces.length > 1`; the Overview one is not.
    expect(cockpitApp).not.toMatch(/m\.workspaces\.length > 1 \?\s*\n?\s*<KitSelect/);
    // Only the "All workspaces" OPTION is conditional (it means nothing with one root).
    expect(cockpitApp).toMatch(/m\.workspaces\.length > 1 \? \[\{ value: ALL_WORKSPACES/);
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

  it("the host writes controlWsHash from exactly one client message", () => {
    const host = readFileSync(path.join(WEBVIEW, "Cockpit.ts"), "utf8");
    const assignments = host.match(/controlWsHash = /g) ?? [];
    // Three: the open-options block (deep link / legacy per-section aliases, all one scope) and the
    // single `switchControlWorkspace` case. Any fourth is a second writer and must be justified here.
    expect(assignments).toHaveLength(4);
    expect(host).toMatch(/case "switchControlWorkspace":[\s\S]*?controlWsHash = c\.wsHash \|\| undefined;/);
    expect(host).not.toMatch(/m\.type === "switchWorkspace"/);
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
