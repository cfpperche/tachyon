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
const WEBVIEW = path.resolve(__dirname, "..", "..", "packages", "webview-ui", "src", "webview");
const HOST_WEBVIEW = path.resolve(__dirname, "..", "..", "src", "webview");

function webviewSources(dir = WEBVIEW): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return webviewSources(full);
    return entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) ? [full] : [];
  });
}

const sidebarApp = readFileSync(path.join(WEBVIEW, "sidebar", "App.tsx"), "utf8");

/**
 * Source with its comments removed, for the guards that ask what a surface OFFERS.
 *
 * Measured, not anticipated: the "no All workspaces option" guard below first read raw source and
 * went red on the comment that explains why the option is absent — the same shape as the 2026-08-03
 * static guard that matched a `case` body as a substring of its own switch. A guard that reads prose
 * is answering a different question from the one it claims to.
 *
 * The `[^:]` before `//` keeps a `https://` inside a string from swallowing the rest of its line.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("the global workspace scope has exactly one control (SDD 485 C6, revised by t-72ff5a)", () => {
  it("only the sidebar renders it, and in the chrome above the tabs — not inside a tab", () => {
    const owners = webviewSources().filter((file) => readFileSync(file, "utf8").includes('data-testid="sidebar-workspace-select"'));
    expect(owners.map((f) => path.relative(WEBVIEW, f))).toEqual(["sidebar/App.tsx"]);

    // t-72ff5a — C6's "exactly one control" is unchanged; WHERE that one control lives is not. It
    // used to sit in the Control tab's `.sec-actions` slot, which was fine while it only scoped the
    // next Control panel to open. It now scopes seven of the nine TABS, and a control that governs
    // seven tabs from inside an eighth is reachable only by leaving what it governs.
    const chrome = /<div class="ws-chrome"[\s\S]*?<\/div>/.exec(sidebarApp)?.[0] ?? "";
    expect(chrome).toContain('data-testid="sidebar-workspace-select"');
    expect(chrome).toContain("<HandoffBtn"); // the handoff pill travels with it (owner, 2026-08-05)

    // and it is genuinely OUTSIDE every tab's own header row
    const secRow = /<div class="sec">[\s\S]*?\n      <\/div>/.exec(sidebarApp)?.[0] ?? "";
    expect(secRow).not.toContain("workspace-select");
    // the old testid is gone rather than renamed in place: it named a home this control no longer has
    expect(sidebarApp).not.toContain("control-workspace-select");
  });

  it("stays on screen with a single project, carrying that one option", () => {
    // Maintainer, 2026-08-03, reversing the first delivery: the selector must be evident at all
    // times, inert rather than absent. A control that appears only once a second project shows up
    // teaches nobody it exists, and the human who needs it is the one who just added that project.
    // t-72ff5a keeps this verbatim — the chrome is unconditional, so one project still renders it.
    expect(sidebarApp).not.toMatch(/fleets\.length > 1[\s\S]{0,200}ws-chrome/);
    expect(sidebarApp).toMatch(/<div class="ws-chrome"/);
    // Every option is a real project: one <option> per fleet, no branch, no sentinel.
    expect(sidebarApp).toMatch(/\{fleets\.map\(\(f\) => <option key=\{f\.folder\?\.hash \?\? ""\} value=\{f\.folder\?\.hash \?\? ""\}>/);
  });

  it("offers no 'All workspaces' — that mode was removed, not hidden (owner, 2026-08-05)", () => {
    // The aggregate is what let seven tabs stack every project under folder headers; keeping it as
    // an option would restore the two-regime state this change exists to end. The legitimate need to
    // watch every project at once belongs to the Attentions tab, which stays cross-project.
    for (const file of webviewSources()) {
      expect(code(readFileSync(file, "utf8")), path.relative(WEBVIEW, file)).not.toContain("All workspaces");
    }
    // …and the model no longer produces the state either: an unset scope resolves to a real project.
    const model = readFileSync(path.resolve(WEBVIEW, "..", "sections", "model.ts"), "utf8");
    expect(model).toContain("const selected = requested ?? workspaces[0]?.hash;");
  });

  it("no screen mirrors it — the Board's own workspace dropdown is gone", () => {
    for (const file of webviewSources()) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(WEBVIEW, file)).not.toContain('data-testid="board-workspace-select"');
      expect(src, path.relative(WEBVIEW, file)).not.toContain('aria-label="Board workspace"');
    }
    // …and so is the action it posted, so no other client can re-target the global scope.
    const boardMessages = readFileSync(path.join(WEBVIEW, "board", "messages.ts"), "utf8");
    expect(boardMessages).not.toContain("switchWorkspace");
  });

  it("the host authority is the window store, not Cockpit module state", () => {
    const sidebarHost = readFileSync(path.join(HOST_WEBVIEW, "SidebarPrototype.ts"), "utf8");
    const extension = readFileSync(path.resolve(HOST_WEBVIEW, "..", "extension.ts"), "utf8");
    expect(sidebarHost).toMatch(/m\?\.type === "switchControlWorkspace"[\s\S]*?controlWorkspaceScope\.set\(hash\)/);
    expect(extension).toContain("controlWorkspaceScope.current");
    expect(webviewSources().some((file) => readFileSync(file, "utf8").includes("let controlWsHash"))).toBe(false);
    expect(() => readFileSync(path.join(WEBVIEW, "Cockpit.ts"), "utf8")).toThrow();
  });
});

describe("local filters are not global selectors (t-46eb4f)", () => {
  it("tmux keeps its Workspace filter — its universe includes closed and other-workspace sessions", () => {
    const inspector = readFileSync(path.join(WEBVIEW, "inspector", "App.tsx"), "utf8");
    // t-6b5dea — the window scope now supplies this filter's DEFAULT, so the initializer is no longer a
    // literal "all". What the filter IS did not change and is what this case protects: a client-side
    // narrowing of the rows already on screen, with "all" still reachable…
    expect(inspector).toMatch(/const \[chosen, setChosen\] = useState<string \| undefined>\(undefined\)/);
    expect(inspector).toMatch(/return chosen \?\? scope\?\.hash \?\? "all";/);
    expect(inspector).toMatch(/workspace !== "all" && \(group\.wsHash \?\? "unscoped"\) !== workspace/);
    // …and the way back to it on screen rather than only in the dropdown, because the default is one
    // nobody chose. `tmuxScopeDefault.test.ts` proves both against a real render; this pins the shape.
    expect(inspector).toContain('setChosen("all")');
    // …that posts nothing: it cannot move the global scope.
    expect(inspector).not.toContain("switchControlWorkspace");
    expect(inspector).not.toContain("switchWorkspace");
  });

  it("the Board keeps the filters that only narrow its own cards", () => {
    const board = readFileSync(path.join(WEBVIEW, "board", "App.tsx"), "utf8");
    expect(board).toContain('aria-label="Search tasks"');
    expect(board).toContain("All agents");
    expect(board).not.toContain("switchControlWorkspace");
  });
});
