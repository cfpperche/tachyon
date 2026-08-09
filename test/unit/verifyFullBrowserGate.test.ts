import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The production runner is plain ESM and intentionally has no declaration surface.
// @ts-expect-error -- this test exercises the owned gate decision directly.
import { browserGateDecision, browserSuiteRoots } from "../../scripts/verify-full.mjs";

const roots: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-browser-gate-"));
  roots.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "browser-gate@example.invalid"]);
  git(cwd, ["config", "user.name", "Browser Gate"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "base\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "-m", "base"]);
  git(cwd, ["switch", "-c", "change"]);
  return cwd;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Write a browser test whose imports are what the derived trigger set is built from. */
function browserSuite(cwd: string, files: Record<string, string>) {
  for (const [rel, source] of Object.entries(files)) {
    const full = path.join(cwd, "test", "browser", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
}

describe("verify:full conditional browser gate (t-6e929b)", () => {
  it("skips, visibly, when the diff touches nothing the browser suite reads", () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "README.md"), "non-webview change\n");

    expect(browserGateDecision({ cwd })).toMatchObject({ run: false, webviewPaths: [] });
  });

  it("runs when a tracked or untracked diff touches src/webview", () => {
    const cwd = repo();
    browserSuite(cwd, { "ui.test.ts": 'import x from "../../src/webview/shared/shell";\n' });
    fs.mkdirSync(path.join(cwd, "src", "webview"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "webview", "App.tsx"), "export {};\n");

    expect(browserGateDecision({ cwd }).webviewPaths).toContain("src/webview/App.tsx");
  });
});

describe("on main the base is what is UNPUSHED, not the last merge (t-d858f5)", () => {
  /**
   * A repo already on `main`, with an `origin/main` ref and a browser suite that reads
   * `src/webview` — both committed in the base, so neither shows up in any later diff.
   */
  function mainRepo() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-browser-gate-main-"));
    roots.push(cwd);
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["config", "user.email", "browser-gate@example.invalid"]);
    git(cwd, ["config", "user.name", "Browser Gate"]);
    fs.writeFileSync(path.join(cwd, "README.md"), "base\n");
    browserSuite(cwd, { "ui.test.ts": 'import x from "../../src/webview/shared/shell";\n' });
    fs.mkdirSync(path.join(cwd, "src", "webview"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "webview", "App.tsx"), "export {};\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "base"]);
    git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return cwd;
  }

  function mergeBranch(cwd: string, name: string, write: () => void) {
    git(cwd, ["switch", "-c", name]);
    write();
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", name]);
    git(cwd, ["switch", "main"]);
    git(cwd, ["merge", "--no-ff", name, "-m", `merge ${name}`]);
  }

  it("still runs when a browser-root merge is followed by one that touches nothing — the shape that shipped 0.60.0 unchecked", () => {
    const cwd = mainRepo();
    // First merge touches a browser root. Second does not, and lands on top before the gate runs.
    mergeBranch(cwd, "touches-webview", () => {
      fs.writeFileSync(path.join(cwd, "src", "webview", "App.tsx"), "export const changed = 1;\n");
    });
    mergeBranch(cwd, "touches-nothing", () => {
      fs.writeFileSync(path.join(cwd, "README.md"), "unrelated\n");
    });

    // With `HEAD^` this returned run:false — the first merge was invisible behind the second, and
    // the release went out with the browser suite skipped over a real change to a browser root.
    const decision = browserGateDecision({ cwd });
    expect(decision.run).toBe(true);
    expect(decision.webviewPaths).toContain("src/webview/App.tsx");
  });

  it("falls back to the previous commit when there is no origin/main, instead of throwing into a silent skip", () => {
    const cwd = mainRepo();
    git(cwd, ["update-ref", "-d", "refs/remotes/origin/main"]);
    mergeBranch(cwd, "touches-webview", () => {
      fs.writeFileSync(path.join(cwd, "src", "webview", "App.tsx"), "export const changed = 1;\n");
    });

    // A missing ref makes `rev-parse --verify` exit non-zero, and `gitOutput` throws on that. The
    // decision must degrade to the old base, NOT land in the outer catch — which would answer
    // `run: false` with "no Git diff available" and skip the suite for the wrong reason.
    const decision = browserGateDecision({ cwd });
    expect(decision.reason).toBeUndefined();
    expect(decision.run).toBe(true);
  });
});

describe("the trigger set is DERIVED from what the browser suite reads (t-e2c8a2)", () => {
  it("triggers on the browser suite's OWN files — the author of a browser test was the one person the old gate never covered", () => {
    const cwd = repo();
    browserSuite(cwd, { "layout.test.ts": "export {};\n" });

    expect(browserGateDecision({ cwd })).toMatchObject({
      run: true,
      webviewPaths: ["test/browser/layout.test.ts"],
    });
  });

  it("triggers on a source directory the suite imports but nobody listed — src/sidebar was six files of real coverage with no trigger", () => {
    const cwd = repo();
    browserSuite(cwd, { "card.test.ts": 'import { row } from "../../src/sidebar/cardTemplate.js";\n' });
    fs.mkdirSync(path.join(cwd, "src", "sidebar"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "sidebar", "cardTemplate.ts"), "export {};\n");

    expect(browserGateDecision({ cwd }).webviewPaths).toContain("src/sidebar/cardTemplate.ts");
  });

  it("resolves each import from ITS OWN directory, so a nested helper's `../../../` is not read as the suite root's", () => {
    const cwd = repo();
    browserSuite(cwd, { "support/gate.ts": 'import { p } from "../../../scripts/webview-preview/pluginFrameGate.js";\n' });

    expect(browserSuiteRoots({ cwd })).toContain("scripts/webview-preview/");
  });

  it("does not trigger on a directory the suite stopped importing — the set shrinks with the suite, which a hand-written list does not", () => {
    const cwd = repo();
    browserSuite(cwd, { "card.test.ts": "export {};\n" });
    fs.mkdirSync(path.join(cwd, "src", "sidebar"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "sidebar", "cardTemplate.ts"), "export {};\n");

    expect(browserGateDecision({ cwd }).webviewPaths).not.toContain("src/sidebar/cardTemplate.ts");
  });

  it("holds for the REAL suite: the roots it reads today include the four the old gate could not see", () => {
    // Derived from the live tree, not from a copy — if the suite drops one of these imports the
    // expectation is meant to be re-measured, which is the point of not hand-writing the list.
    const roots = browserSuiteRoots({ cwd: path.resolve(__dirname, "..", "..") });
    expect(roots).toEqual(expect.arrayContaining([
      "test/browser/", "vitest.browser.config.ts",
      "src/webview/", "src/sidebar/", "src/agents/", "src/sections/", "scripts/webview-preview/",
    ]));
  });
});
