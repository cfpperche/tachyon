import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * t-a1ba6c — regression: Agent/Terminal Studio advanced worktree sections must live in the main
 * `fields` region (document flow under Working directory), NOT in StudioFrame `sideActions`.
 * sideActions is a sibling after flex:1 main and pins content to the viewport bottom with a huge void.
 */

const root = path.resolve(__dirname, "../..");

function readSrc(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("t-a1ba6c studio worktree sections are in-flow fields (not sideActions footer)", () => {
  it("agent-studio-shell places the worktree section in fields and omits sideActions", () => {
    const src = readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx");
    expect(src).toContain("Separate git checkout + branch");
    expect(src).toContain("ash-cwd");
    // worktree markup is inside the fields region tree, not a sideActions prop
    expect(src).not.toMatch(/sideActions\s*:/);
    // ordering: Working directory input appears before the worktree summary in source
    const cwdAt = src.indexOf('for="ash-cwd"');
    const worktreeAt = src.indexOf("Separate git checkout + branch");
    expect(cwdAt).toBeGreaterThan(-1);
    expect(worktreeAt).toBeGreaterThan(cwdAt);
  });

  /**
   * t-aa06a8 — the "Isolated harness" section this case used to assert the POSITION of is gone: it
   * rendered under `showHarness && !canonical`, `canonical` is true for every agent Agent Studio can
   * load, and the canonical profile schema has no `harness` key to save into. The layout claim has no
   * subject left, so what survives is the tripwire that it does not come back.
   *
   * Comments are stripped first, for the reason `terminalStudioAgentOnlyKeys.test.ts` gives about its
   * own tripwire: App.tsx's header NAMES the removed section to explain why it went, and a check that
   * trips on its own explanation teaches the next person to delete the explanation.
   */
  it("agent-studio-shell binds no isolated-harness control (t-aa06a8)", () => {
    const src = readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("Isolated harness");
    expect(src).not.toContain("ash-harness-title");
    for (const field of ["harness", "harnessInherit", "harnessMcp", "harnessRules", "harnessInstructions", "harnessSkills", "harnessHooks"]) {
      expect(src, `App.tsx writes '${field}', which no longer exists on the form state`).not.toContain(`set("${field}"`);
      expect(src, `App.tsx reads fields.${field}, which no longer exists on the form state`).not.toContain(`fields.${field}`);
    }
  });

  it("renders agent configuration blocks as always-expanded static sections", () => {
    const src = readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx");
    const css = readSrc("packages/webview-ui/src/webview/agent-studio-shell/agent-studio-shell.css");
    expect(src).not.toContain("<details");
    expect(src).not.toContain("<summary");
    expect(src).toContain('class="ash-static-section" aria-labelledby="ash-persistent-instructions-title"');
    expect(src).toContain('class="ash-static-section" aria-labelledby="ash-worktree-title"');
    expect(css).toContain(".ash-static-section");
    expect(css).not.toContain(".ash-fields details");
  });

  it("does not expose the deprecated transcript-isolation toggle in either Agent Studio mode", () => {
    const src = readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx");
    expect(src).not.toContain("Isolate runtime transcript/config home");
    expect(src).not.toContain('set("isolate"');
  });

  /**
   * t-b54ead — Terminal Studio has NO worktree section any more, so the layout claim this case made
   * for it no longer has a subject. What survives is the half that is still about layout: the
   * terminal fields live in the `fields` region and nothing is pinned to a `sideActions` footer.
   * The absence of the worktree controls is not asserted here — it is a domain rule, measured
   * against the loader in `terminalStudioAgentOnlyKeys.test.ts`.
   */
  it("terminal-studio-shell keeps its fields in the fields region and omits sideActions", () => {
    const src = readSrc("packages/webview-ui/src/webview/terminal-studio-shell/App.tsx");
    expect(src).toContain("tsh-cwd");
    expect(src).not.toMatch(/sideActions\s*:/);
    expect(src.indexOf('for="tsh-cwd"')).toBeGreaterThan(-1);
  });
});
