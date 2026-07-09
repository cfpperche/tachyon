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
  it("agent-studio-shell places worktree + harness in fields and omits sideActions", () => {
    const src = readSrc("src/webview/agent-studio-shell/App.tsx");
    expect(src).toContain("Git worktree isolation");
    expect(src).toContain("Isolated harness");
    expect(src).toContain("ash-cwd");
    // worktree markup is inside the fields region tree, not a sideActions prop
    expect(src).not.toMatch(/sideActions\s*:/);
    // ordering: Working directory input appears before the worktree summary in source
    const cwdAt = src.indexOf('for="ash-cwd"');
    const worktreeAt = src.indexOf("Git worktree isolation");
    const harnessAt = src.indexOf("Isolated harness");
    expect(cwdAt).toBeGreaterThan(-1);
    expect(worktreeAt).toBeGreaterThan(cwdAt);
    expect(harnessAt).toBeGreaterThan(worktreeAt);
  });

  it("terminal-studio-shell places worktree in fields and omits sideActions", () => {
    const src = readSrc("src/webview/terminal-studio-shell/App.tsx");
    expect(src).toContain("Git worktree isolation");
    expect(src).toContain("tsh-cwd");
    expect(src).not.toMatch(/sideActions\s*:/);
    const cwdAt = src.indexOf('for="tsh-cwd"');
    const worktreeAt = src.indexOf("Git worktree isolation");
    expect(cwdAt).toBeGreaterThan(-1);
    expect(worktreeAt).toBeGreaterThan(cwdAt);
  });
});
