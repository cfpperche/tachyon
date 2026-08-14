import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { annotateAuthorized, listAuthorizableCapabilities, type AuthorizableCapabilities, type AuthorizedState } from "@tachyon/engine/config/agentCapabilityCandidates.js";

/**
 * t-5498a6 — the two candidate lists a human chooses from.
 *
 * They are separate because the things in them are separate: a plugin is versioned and pinned at its
 * own tree, a hand-written skill has only its content. The discriminator is the LOCKFILE, and the
 * tests that matter here are the ones where content and lockfile disagree.
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cands-"));
  dirs.push(dir);
  return dir;
}

function writeSkill(root: string, relative: string): void {
  fs.mkdirSync(path.join(root, relative), { recursive: true });
  fs.writeFileSync(path.join(root, relative, "SKILL.md"), "# x\n");
}

function writeLock(root: string, plugins: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tachyon/plugins.lock.json"), JSON.stringify({ schemaVersion: 1, plugins }));
}

const visualQa = {
  name: "visual-qa", version: "0.3.1", runtimes: ["claude", "codex"],
  targets: [
    { runtime: "claude", kind: "skill-dir", file: ".claude/skills/visual-qa" },
    { runtime: "codex", kind: "skill-dir", file: ".agents/skills/visual-qa" },
  ],
};

describe("t-5498a6 — the lockfile decides which list a skill belongs to", () => {
  it("keeps a plugin skill OUT of the workspace list even when its content was edited by hand", () => {
    // The case that makes content comparison wrong: the tree on disk no longer matches the plugin,
    // and it is still the plugin's. Classifying it as hand-written would pin the wrong source.
    const root = workspace();
    writeLock(root, { "visual-qa": visualQa });
    writeSkill(root, ".claude/skills/visual-qa");
    writeSkill(root, ".claude/skills/house-style");

    const result = listAuthorizableCapabilities(root, "claude");

    expect(result.workspaceSkills.map((skill) => skill.name)).toEqual(["house-style"]);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["visual-qa"]);
  });

  it("reads the runtime's OWN skills directory, not the other runtime's", () => {
    const root = workspace();
    writeLock(root, {});
    writeSkill(root, ".agents/skills/codex-only");

    expect(listAuthorizableCapabilities(root, "codex").workspaceSkills.map((s) => s.name)).toEqual(["codex-only"]);
    expect(listAuthorizableCapabilities(root, "claude").workspaceSkills).toEqual([]);
  });

  it("t-84c678: surfaces Grok project skills for explicit per-agent authorization", () => {
    const root = workspace();
    writeLock(root, {});
    writeSkill(root, ".grok/skills/grok-only");

    expect(listAuthorizableCapabilities(root, "grok").workspaceSkills).toEqual([
      { name: "grok-only", path: ".grok/skills/grok-only" },
    ]);
  });
});

describe("t-5498a6 — a plugin that cannot be authorized is SHOWN with the reason, never hidden", () => {
  it("names the runtimes a plugin does install for", () => {
    // Hiding it would make "installs only for claude" indistinguishable from "not installed".
    const root = workspace();
    writeLock(root, {
      "product-foundation": {
        name: "product-foundation", version: "0.1.1", runtimes: ["claude"],
        targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/product-foundation" }],
      },
    });

    const plugin = listAuthorizableCapabilities(root, "codex").plugins[0]!;

    expect(plugin.authorizable).toBe(false);
    expect(plugin.reason).toContain("installs for claude");
    expect(plugin.reason).toContain("not codex");
  });

  it("REFUSES a plugin whole when it exposes something no grant can carry", () => {
    // Ratified with the user: authorizing a plugin authorizes everything it exposes. So a plugin that
    // also installs a settings-hook cannot be half-authorized — that would report success while the
    // hook never reached the agent, which is the silent gap this slice exists to end.
    const root = workspace();
    writeLock(root, {
      "secrets-guard": {
        name: "secrets-guard", version: "2.0.4", runtimes: ["claude", "codex"],
        targets: [
          { runtime: "claude", kind: "settings-hook", file: ".claude/settings.json" },
          { runtime: "claude", kind: "skill-dir", file: ".claude/skills/guard-helper" },
        ],
      },
    });

    const plugin = listAuthorizableCapabilities(root, "claude").plugins[0]!;

    expect(plugin.authorizable).toBe(false);
    expect(plugin.ungrantableKinds).toEqual(["settings-hook"]);
    expect(plugin.reason).toContain("settings-hook");
    expect(plugin.reason).toContain("half the plugin");
  });

  it("OMITS a git-hook-only plugin from the selector and names it as a checkout fact", () => {
    // t-c01f91 — measured: `core.hooksPath` is repository-level config, shared by every worktree, so
    // verify-gate already applies to every agent and there is nothing to authorize. Listing it as
    // "installs nothing for claude" is technically true and semantically false — it reads as absence
    // while the gate is working. Dropping it silently would be the other half of the same lie.
    const root = workspace();
    writeLock(root, {
      "verify-gate": { name: "verify-gate", version: "1.0.2", runtimes: [], targets: [] },
      "visual-qa": visualQa,
    });

    const result = listAuthorizableCapabilities(root, "claude");

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["visual-qa"]);
    expect(result.checkoutOnlyPlugins).toEqual(["verify-gate"]);
  });

  it("keeps a plugin that installs for ANOTHER runtime in the list, with the reason", () => {
    // Distinct from the case above: this one IS a capability, just not for this agent. Omitting it
    // would make "installs only for codex" indistinguishable from "not installed".
    const root = workspace();
    writeLock(root, {
      "product-foundation": {
        name: "product-foundation", version: "0.1.1", runtimes: ["codex"],
        targets: [{ runtime: "codex", kind: "skill-dir", file: ".agents/skills/product-foundation" }],
      },
    });

    const result = listAuthorizableCapabilities(root, "claude");

    expect(result.plugins).toHaveLength(1);
    expect(result.checkoutOnlyPlugins).toEqual([]);
  });

  it("authorizes a plugin whose every target for this runtime is a skill", () => {
    const root = workspace();
    writeLock(root, { "visual-qa": visualQa });

    const plugin = listAuthorizableCapabilities(root, "claude").plugins[0]!;

    expect(plugin.authorizable).toBe(true);
    expect(plugin.skills).toEqual(["visual-qa"]);
    expect(plugin.reason).toBeUndefined();
  });
});

describe("t-5498a6 — an unreadable or absent lockfile is an empty plugin list, not a crash", () => {
  it("returns the workspace skills anyway", () => {
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style");

    const result = listAuthorizableCapabilities(root, "claude");

    expect(result.plugins).toEqual([]);
    expect(result.workspaceSkills.map((skill) => skill.name)).toEqual(["house-style"]);
  });
});

/**
 * t-4a2a6f — folding "what the agent already holds" into the candidate lists.
 *
 * The roll-up rule is the whole point: a plugin is authorized WHOLE, so one drifted skill makes the
 * plugin stale. Getting this wrong renders a plain Authorize button on an entry the core will refuse
 * to write, which is exactly the silent no-op this closes.
 */
describe("t-4a2a6f — annotating candidates with what the agent already holds", () => {
  const base = (): AuthorizableCapabilities => ({
    workspaceSkills: [{ name: "house-style", path: ".claude/skills/house-style" }],
    plugins: [{
      name: "multi", version: "2.0.0", runtimes: ["claude"],
      skills: ["alpha", "beta"], ungrantableKinds: [], authorizable: true,
    }],
    checkoutOnlyPlugins: [],
  });
  const held = (entries: Record<string, AuthorizedState>) => new Map(Object.entries(entries));

  it("leaves an unheld candidate unannotated — absent is not the same as current", () => {
    const result = annotateAuthorized(base(), held({}));
    expect(result.workspaceSkills[0]!.authorized).toBeUndefined();
    expect(result.plugins[0]!.authorized).toBeUndefined();
  });

  it("marks a plugin stale when ANY of its skills drifted", () => {
    const result = annotateAuthorized(base(), held({
      alpha: { version: "1.0.0", stale: false },
      beta: { version: "1.0.0", stale: true },
    }));
    expect(result.plugins[0]!.authorized).toEqual({ version: "1.0.0", stale: true });
  });

  it("reports a fully-current plugin as authorized and not stale", () => {
    const result = annotateAuthorized(base(), held({
      alpha: { version: "2.0.0", stale: false },
      beta: { version: "2.0.0", stale: false },
    }));
    expect(result.plugins[0]!.authorized).toEqual({ version: "2.0.0", stale: false });
  });

  it("treats a plugin that GAINED a skill as stale — half a plugin is the failure the whole-plugin rule exists to stop", () => {
    // The agent authorized `alpha` when that was all the plugin had; the update added `beta`. Nothing
    // drifted, yet the agent holds half. Reauthorizing is the gesture that makes it whole again.
    const result = annotateAuthorized(base(), held({ alpha: { version: "1.0.0", stale: false } }));
    expect(result.plugins[0]!.authorized).toEqual({ version: "1.0.0", stale: true });
  });

  it("annotates a hand-written skill, which carries no version", () => {
    const result = annotateAuthorized(base(), held({ "house-style": { stale: true } }));
    expect(result.workspaceSkills[0]!.authorized).toEqual({ stale: true });
  });
});
