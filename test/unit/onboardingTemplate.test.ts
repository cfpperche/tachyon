import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfileAwareConfig } from "@tachyon/engine/config/agentProfileConfigLoader.js";
import { composeWorkspaceConfigText, workspaceSettingsPath } from "@tachyon/engine/config/workspaceSettingsFile.js";
import { agentsOf, terminalsOf } from "@tachyon/engine/config/loadConfig.js";
import { buildStarterFiles, type DetectedProject } from "../../apps/vscode-extension/src/init/initLogic.js";

/**
 * t-fe772a — the ONBOARDING ARTIFACT, exercised the way a newcomer exercises it.
 *
 * t-a65335 — `tachyon.yml.example` was removed together with the file it documented. The onboarding
 * path is now `Tachyon: Init`, which writes `.tachyon/settings.yml` (top level IS the settings
 * mapping) plus one `.tachyon/terminals/<name>.yml` per detected process. The artifact rotting the
 * same way is still the risk: everyone here has a live workspace already, so nobody re-runs Init.
 *
 * The path still has TWO doors and this file walks both, because passing one proves nothing about
 * the other:
 *   1. the loader — do the files Init writes produce a usable config?
 *   2. the editor — `package.json` binds `dist/tachyon.schema.json` to `.tachyon/settings.yml`
 *      through `contributes.yamlValidation`, and that schema closes the mapping with
 *      `additionalProperties: false`. Measured 2026-08-10 (on the old template): the file loaded
 *      perfectly and still lit up with "must NOT have additional properties" errors the moment it
 *      was opened, because keys had been added to the parser and not to the schema. Green on door 1,
 *      red on door 2, and door 2 is the one the newcomer sees first.
 */

const repoRoot = process.cwd();
// t-a65335 — the schema's top level IS the settings subtree now (no `settings:` wrapper).
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "vscode-extension", "tachyon.schema.json"), "utf8")) as {
  properties: Record<string, unknown>;
  additionalProperties?: boolean;
};

const roots: string[] = [];
function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A representative newcomer project: Node with dev/test scripts, one detected CLI. */
const DETECTED: DetectedProject = {
  files: ["package.json"],
  packageJson: { scripts: { dev: "vite", test: "vitest" } },
  installedClis: ["claude"],
};

/** Write the starter files exactly as the `tachyon.init` command handler does. */
function initWorkspace(detected: DetectedProject = DETECTED): { root: string; starter: ReturnType<typeof buildStarterFiles> } {
  const root = temporaryRoot("tachyon-onboarding-init-workspace-");
  const starter = buildStarterFiles(detected);
  const target = workspaceSettingsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, starter.settingsYaml, "utf8");
  const terminalsDir = path.join(root, ".tachyon", "terminals");
  fs.mkdirSync(terminalsDir, { recursive: true });
  for (const terminal of starter.terminals) {
    fs.writeFileSync(path.join(terminalsDir, `${terminal.name}.yml`), terminal.yaml, "utf8");
  }
  return { root, starter };
}

/** Load the workspace through the production composition + loader, as an attach would. */
function loadAsFreshCheckout(root: string) {
  const composed = composeWorkspaceConfigText(root);
  expect(composed.errors).toEqual([]);
  expect(composed.warnings).toEqual([]);
  return loadProfileAwareConfig({
    yamlText: composed.yamlText,
    workspaceRoot: root,
    authorities: new Map(),
    homeDir: temporaryRoot("tachyon-onboarding-init-home-"),
  });
}

describe("Tachyon: Init starter files — the documented onboarding path (t-a65335)", () => {
  it("door 1: loads through the production loader with nothing refused and nothing ignored", () => {
    const { root, starter } = initWorkspace();
    const result = loadAsFreshCheckout(root);

    expect(result.errors, starter.settingsYaml).toEqual([]);
    expect(result.config).toBeDefined();
    // Not just "it loaded": every setting the starter declares has to ARRIVE. `discarded` and
    // `warnings` are where a retired key lands (the product warns, never blocks — so a dead key in
    // the starter leaves `errors` empty and would sail past a test that only checked errors).
    expect(result.discarded, starter.settingsYaml).toEqual([]);
    expect(result.warnings, starter.settingsYaml).toEqual([]);
    expect(result.config?.settings).toEqual(parseYaml(starter.settingsYaml));
    // t-ae221c — Init declares no roster on purpose: an agent IS a directory under
    // `.tachyon/agents/`, created in Agent Studio. An empty checkout is an empty fleet, not a failure.
    expect(agentsOf(result.config)).toEqual({});
    // The detected processes arrive as terminal declarations, one file each.
    expect(Object.keys(terminalsOf(result.config)).sort()).toEqual(["dev", "shell", "test"]);
  });

  it("t-4ab1d8: the starter never suggests a node_modules share", () => {
    const { starter } = initWorkspace();
    // The pre-monorepo template listed `- node_modules` as a share to copy. That is the defect this
    // guard keeps dead: resurrecting it would recreate 2.368 redirected imports.
    expect(starter.settingsYaml).not.toMatch(/node_modules/);
    for (const terminal of starter.terminals) expect(terminal.yaml).not.toMatch(/node_modules/);
  });

  it("door 2: every key the starter declares OR invites is published by the schema VS Code validates with", () => {
    const { starter } = initWorkspace();
    const published = Object.keys(schema.properties);

    const declared = Object.keys((parseYaml(starter.settingsYaml) ?? {}) as Record<string, unknown>);
    expect(declared.filter((key) => !published.includes(key))).toEqual([]);
    // The commented suggestions are part of the artifact too: uncommenting one must not light up
    // "must NOT have additional properties" in the newcomer's editor.
    for (const invited of ["maxAgents", "bridgePort", "tmux", "worktree"]) {
      expect(published, starter.settingsYaml).toContain(invited);
    }
    expect(schema.additionalProperties).toBe(false);
  });

  it("a retired key in the starter would be warned about, never blocked — and door 1 would catch it", () => {
    // The guard from the test above, proven red rather than trusted. `settings.verify` is the real
    // recurrence: t-f559b6 removed it from the product on 2026-08-09, and the template of the day
    // happened to have already dropped it. Had it not, the config would still load — invalid config
    // WARNS and never blocks — and only the `discarded` assertion above would have noticed.
    const { root } = initWorkspace();
    const target = workspaceSettingsPath(root);
    fs.appendFileSync(target, "\nverify:\n  command: npm test\n", "utf8");
    const result = loadAsFreshCheckout(root);

    expect(result.errors).toEqual([]);
    expect(result.config).toBeDefined();
    expect(result.discarded).toEqual(["settings: unknown key 'verify'"]);
    expect(Object.keys(schema.properties)).not.toContain("verify");
  });
});
