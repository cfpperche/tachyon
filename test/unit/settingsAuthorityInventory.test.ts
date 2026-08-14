/**
 * t-aaad95 — the guard that keeps the removal removed.
 *
 * A one-time cut is only worth as much as the thing that stops it growing back. These assertions are
 * an inventory, not a style rule: each one names a way the old surface could reappear (a contributed
 * key, a stray reader, an orphan localization string, a generic settings port) and fails the build
 * when it does.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// `process.cwd()` is the repo root under vitest here; `import.meta.url` is unavailable because this
// project also type-checks the test tree as CommonJS.
const repoRoot = process.cwd();

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8")) as Record<string, unknown>;
}

/** `git grep -n` over tracked files, so the guard cannot be fooled by an untracked scratch file. */
function grep(pattern: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync("git", ["grep", "-n", "-e", pattern, "--", ...pathspecs], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out.split("\n").filter((line) => line.trim().length > 0);
  } catch (error) {
    // git grep exits 1 with no output when there is no match — that is the passing case.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
}

const SELF = "test/unit/settingsAuthorityInventory.test.ts";

function withoutSelfAndDocs(lines: string[]): string[] {
  // Docs and the ratified proposal describe the removal; naming a retired key there is the point.
  return lines.filter((line) => !line.startsWith(SELF) && !line.startsWith("docs/"));
}

describe("Tachyon contributes no settings", () => {
  it("package.json has no contributes.configuration at all", () => {
    const contributes = readJson("apps/vscode-extension/package.json").contributes as Record<string, unknown>;
    expect(Object.keys(contributes)).not.toContain("configuration");
  });

  it("no tachyon.* configuration key is contributed under any other contribution point", () => {
    const text = fs.readFileSync(path.join(repoRoot, "apps/vscode-extension/package.json"), "utf8");
    for (const key of [
      "tachyon.maxAgents",
      "tachyon.agentMemoryMax",
      "tachyon.taskNotifications.enabled",
      "tachyon.taskNotifications.events",
      "tachyon.taskNotifications.suppressOwnChanges",
      "tachyon.taskNotifications.dedupeWindowMs",
      "tachyon.activity.codeTheme",
      "tachyon.worktrees.revealInWorkspace",
      "tachyon.gitPath",
      "tachyon.agentPane.enabled",
      "tachyon.sidebar.cardTemplate",
    ]) {
      expect(text, `package.json still mentions the retired key ${key}`).not.toContain(key);
    }
  });

  it("both localization bundles dropped every config.* string", () => {
    for (const bundle of ["apps/vscode-extension/package.nls.json", "apps/vscode-extension/package.nls.pt-br.json"]) {
      const orphans = Object.keys(readJson(bundle)).filter((key) => key.startsWith("config."));
      expect(orphans, `${bundle} has orphan localization strings`).toEqual([]);
    }
  });

  it("the two bundles still declare the same keys", () => {
    expect(Object.keys(readJson("apps/vscode-extension/package.nls.pt-br.json")).sort())
      .toEqual(Object.keys(readJson("apps/vscode-extension/package.nls.json")).sort());
  });
});

describe("no reader of the retired surface survives", () => {
  it("exactly one site reads a `tachyon` configuration section, and it is the one-time import", () => {
    // Named, not pattern-matched. The one-time import must read the retired keys a final time or
    // anyone who had configured them silently drops to a default; allowing that ONE file by name is
    // what stops the exception from quietly becoming a permanent VS Code fallback somewhere else.
    const readers = withoutSelfAndDocs(grep('getConfiguration("tachyon"', ["src", "apps", "test", "scripts"]))
      .map((line) => line.split(":")[0]);
    expect([...new Set(readers)]).toEqual(["apps/vscode-extension/src/workspace/legacyVsCodeSettings.ts"]);
  });

  it("the generic settings port is gone from EngineHost and every implementation", () => {
    // `getSetting`/`getSettingInspect` are what let eight readers grow around the abstraction. The
    // one surviving external setting has its own named port instead — see EngineHost.gitExtensionPath.
    expect(withoutSelfAndDocs(grep("getSettingInspect", ["src", "apps", "test", "scripts"]))).toEqual([]);
    expect(withoutSelfAndDocs(grep("getSetting<", ["src", "apps", "test", "scripts"]))).toEqual([]);
  });

  it("the shell hands the engine exactly one setting, and it is somebody else's", async () => {
    const { DAEMON_SETTING_KEYS } = await import("@tachyon/engine/workspace/DaemonEngineHost.js");
    expect([...DAEMON_SETTING_KEYS]).toEqual(["git.path"]);
  });

  /**
   * The gap that let a real orphan through: this guard checked package.json for the retired key
   * NAMES but only grepped the tree for reader SHAPES. `test/integration/extension.test.js` went on
   * dereferencing `contributes.configuration.properties["tachyon.maxAgents"]` — and because
   * `verify:full` runs neither `test:integration` nor `test:browser`, nothing failed. A retired id
   * quoted as a string is a reference to a surface that no longer exists, wherever it appears.
   */
  it("no retired setting id survives as a string literal, including where the gate cannot run it", () => {
    const retired = [
      "tachyon.maxAgents",
      "tachyon.agentMemoryMax",
      "tachyon.taskNotifications",
      "tachyon.activity.codeTheme",
      "tachyon.worktrees.revealInWorkspace",
      "tachyon.gitPath",
      "tachyon.agentPane.enabled",
      "tachyon.sidebar.cardTemplate",
      "tachyon.openSettings",
    ];
    const offenders = retired.flatMap((id) => [
      ...withoutSelfAndDocs(grep(`"${id}`, ["src", "apps", "test", "scripts"])),
      ...withoutSelfAndDocs(grep(`'${id}`, ["src", "apps", "test", "scripts"])),
    ]);
    expect(offenders).toEqual([]);
  });

  it("no `maxAgents` duplication is left between the shell and tachyon.yml", () => {
    expect(withoutSelfAndDocs(grep("getMaxAgents", ["src", "apps", "test", "scripts"]))).toEqual([]);
    expect(withoutSelfAndDocs(grep("getAgentMemoryMax", ["src", "apps", "test", "scripts"]))).toEqual([]);
  });
});
