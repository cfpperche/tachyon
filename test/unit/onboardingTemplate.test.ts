import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";

/**
 * t-fe772a — the ONBOARDING ARTIFACT, exercised the way a newcomer exercises it.
 *
 * `tachyon.yml.example` is the only file a person who clones this repository reads before anything
 * runs, and it is the one file nobody here ever opens: we all have a live `tachyon.yml` already. It
 * broke exactly that way once — it declared retired inline agents, so `cp tachyon.yml.example
 * tachyon.yml` produced a config that did not load AT ALL. A template read only by humans rots; a
 * template a test loads does not.
 *
 * The path has TWO doors and this file walks both, because passing one proves nothing about the
 * other:
 *   1. the loader — does the copied file produce a usable config?
 *   2. the editor — `package.json` binds `dist/tachyon.schema.json` to `tachyon.yml` through
 *      `contributes.yamlValidation`, and that schema closes `settings:` with
 *      `additionalProperties: false`. Measured 2026-08-10: the template loaded perfectly and still
 *      lit up with two "must NOT have additional properties" errors the moment it was opened,
 *      because `humanInbox` and `agentNotifications` had been added to the parser and not to the
 *      schema. Green on door 1, red on door 2, and door 2 is the one the newcomer sees first.
 */

const repoRoot = process.cwd();
const exampleText = fs.readFileSync(path.join(repoRoot, "tachyon.yml.example"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "src", "config", "tachyon.schema.json"), "utf8")) as {
  properties: Record<string, { properties?: Record<string, unknown> }>;
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

function loadAsFreshCheckout(yamlText: string) {
  // The TRACKED template is the subject; the fleet on the runner's disk is not. Since t-ae221c the
  // roster is `.tachyon/agents/`, so `workspaceRoot` has to be a disposable empty directory —
  // pointing it at this checkout would make the assertion about whoever ran it (green in an agent
  // worktree, red in the primary checkout, where real agents get refused against an empty authority
  // map).
  return loadProfileAwareConfig({
    yamlText,
    workspaceRoot: temporaryRoot("tachyon-onboarding-example-workspace-"),
    authorities: new Map(),
    homeDir: temporaryRoot("tachyon-onboarding-example-home-"),
  });
}

describe("tachyon.yml.example — the documented onboarding path", () => {
  it("door 1: loads through the production loader with nothing refused and nothing ignored", () => {
    const result = loadAsFreshCheckout(exampleText);

    expect(result.errors, exampleText).toEqual([]);
    expect(result.config).toBeDefined();
    // Not just "it loaded": every setting the template declares has to ARRIVE. `discarded` and
    // `warnings` are where a retired key lands (the product warns, never blocks — so a dead key in
    // the template leaves `errors` empty and would sail past a test that only checked errors).
    expect(result.discarded, exampleText).toEqual([]);
    expect(result.warnings, exampleText).toEqual([]);
    expect(result.config?.settings).toEqual((parseYaml(exampleText) as { settings: unknown }).settings);
    // t-ae221c — the template declares no roster on purpose: an agent IS a directory under
    // `.tachyon/agents/`, created in Agent Studio. An empty checkout is an empty fleet, not a failure.
    expect(result.config?.agents).toEqual({});
  });

  it("door 2: every key the template declares is published by the schema VS Code validates it with", () => {
    const declared = parseYaml(exampleText) as Record<string, Record<string, unknown>>;
    const publishedTopLevel = Object.keys(schema.properties);
    const publishedSettings = Object.keys(schema.properties.settings?.properties ?? {});

    expect(Object.keys(declared).filter((key) => !publishedTopLevel.includes(key))).toEqual([]);
    expect(Object.keys(declared.settings ?? {}).filter((key) => !publishedSettings.includes(key))).toEqual([]);
  });

  it("a retired key in the template would be warned about, never blocked — and door 1 would catch it", () => {
    // The guard from the test above, proven red rather than trusted. `settings.verify` is the real
    // recurrence: t-f559b6 removed it from the product on 2026-08-09, one day before this file was
    // written, and the template happened to have already dropped it. Had it not, the config would
    // still load — which is the owner's rule, invalid config WARNS and never blocks — and only the
    // `discarded` assertion above would have noticed.
    const withRetiredKey = `${exampleText}\n  verify:\n    command: npm test\n`;
    const result = loadAsFreshCheckout(withRetiredKey);

    expect(result.errors).toEqual([]);
    expect(result.config).toBeDefined();
    expect(result.discarded).toEqual(["settings: unknown key 'verify'"]);
    expect(Object.keys(schema.properties.settings?.properties ?? {})).not.toContain("verify");
  });
});
