/**
 * The two hand-driven dogfood fixtures must actually reproduce their scenarios.
 *
 * A fixture that quietly stops reproducing is worse than no fixture: it costs a human a dev-host
 * launch, a login, four clicks and a window reload to discover, and what they see then is
 * indistinguishable from the product regressing. Both scenarios are driven here by the same
 * `drift.sh` the human runs, over a throwaway copy shaped like the dev-host mirror.
 *
 * This is not a second copy of the unit tests for t-4a2a6f / t-588644. Those pin the BEHAVIOUR
 * against hand-built inputs; these pin the FIXTURES — that their plugin trees, lockfile and drift
 * script still produce the states their READMEs promise.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { makeTempDir } from "../helpers/tempDir.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { parseLockfile } from "../../src/plugins/lockfile.js";
import { annotateAuthorized, listAuthorizableCapabilities } from "../../src/config/agentCapabilityCandidates.js";
import { authorizedSkillStates, skillOriginFor } from "../../src/config/agentSkillAuthorizationService.js";
import { inspectCapabilitySourceAtRoot } from "../../src/config/agentCapabilitySource.js";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import type { AgentProfileReferenceV1 } from "../../src/config/agentProfileSchema.js";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * A fixture file that `.gitignore` swallows is a fixture that does not exist for anyone else.
 *
 * `.tachyon/`, `.claude/`, `.agents/` and `tachyon.yml` are ignored because they are a real
 * workspace's runtime state. A dogfood fixture is a workspace ON PURPOSE, so every one of those
 * rules hits it — and both fixtures added for t-4a2a6f / t-588644 committed as a README and a shell
 * script, with every file that makes them run left untracked on the author's disk. Tests passed
 * locally and the push gate failed in a clean checkout with `profile/missing-reference`. Two older
 * fixtures were already shipping empty the same way.
 *
 * The negations in `.gitignore` fix the four known rules. This fails if a future rule reaches
 * fixture content again, which is the part nobody would think to re-check.
 *
 * Scoped to the shapes that ARE source. Most of what lands in a fixture's `.tachyon/` really is
 * runtime state — activity, sqlite, sessions, tasks a local run wrote — and stays ignored on
 * purpose, so a blanket "nothing under test/fixtures is ignored" would be a rule the repo cannot
 * hold and would be silenced within a week.
 */
const FIXTURE_SOURCE = [
  /\/tachyon\.ya?ml$/,
  /\/\.claude\//,
  /\/\.agents\//,
  /\/\.tachyon\/plugins(\.lock\.json|\/)/,
];

describe("dogfood fixtures are source, not runtime state", () => {
  it("has no ignored file among the shapes a fixture needs to run", () => {
    const listed = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "test/fixtures/"], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
    }).trim();
    const ignored = listed === "" ? [] : listed.split("\n");

    expect(ignored.filter((file) => FIXTURE_SOURCE.some((shape) => shape.test(`/${file}`)))).toEqual([]);
  });
});

/**
 * Copy a fixture the way `point` mirrors it. The marker file is what `drift.sh` checks before it
 * will write anything — without it the script refuses, which is the guard that keeps a hand-driven
 * scenario from editing the tracked source.
 */
function mirror(slug: string): string {
  const root = makeTempDir(`${slug}-`);
  fs.cpSync(path.join(FIXTURES, `${slug}-dogfood`), root, { recursive: true });
  fs.writeFileSync(path.join(root, ".tachyon-dev-host.json"), '{"schemaVersion":1,"kind":"tachyon-dev-host"}');
  return root;
}

function drift(root: string): void {
  execFileSync("sh", [path.join(root, "drift.sh")], { stdio: "pipe" });
}

/** The pinned reference Agent Studio writes when a human authorizes one plugin skill. */
function pinnedReference(root: string, plugin: string): AgentProfileReferenceV1 {
  const rel = `.tachyon/plugins/${plugin}/skills/${plugin}`;
  return {
    id: plugin, kind: "skill", scope: "project", owner: `plugin:${plugin}`,
    path: rel, mode: "pinned", sha256: inspectCapabilitySourceAtRoot(root, rel).sha256, version: "1.0.0",
  } as AgentProfileReferenceV1;
}

describe("agent-capability-reauth fixture (t-4a2a6f)", () => {
  /** What the Studio's plugin selector renders for each candidate. */
  function controls(root: string, references: readonly AgentProfileReferenceV1[]): string[] {
    const capabilities = annotateAuthorized(
      listAuthorizableCapabilities(root, "claude"),
      authorizedSkillStates(root, references),
    );
    return capabilities.plugins.map((plugin) => {
      if (!plugin.authorizable) return `${plugin.name} refused: ${plugin.reason}`;
      if (plugin.authorized === undefined) return `${plugin.name}@${plugin.version} Authorize`;
      if (plugin.authorized.stale) {
        return `${plugin.name}@${plugin.version} Reauthorize (authorized at ${plugin.authorized.version})`;
      }
      return `${plugin.name}@${plugin.version} Authorized`;
    });
  }

  it("walks Authorize -> Authorized -> Reauthorize, and leaves the control alone", () => {
    const root = mirror("agent-capability-reauth");
    expect(parseConfig(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).errors).toEqual([]);
    expect(parseLockfile(fs.readFileSync(path.join(root, ".tachyon/plugins.lock.json"), "utf8")).errors).toEqual([]);
    for (const name of ["demo-stable", "demo-drifty"]) {
      expect(skillOriginFor(root, name, "claude")).toMatchObject({ kind: "plugin", plugin: name });
    }

    expect(controls(root, [])).toEqual([
      "demo-drifty@1.0.0 Authorize",
      "demo-stable@1.0.0 Authorize",
    ]);

    const references = ["demo-stable", "demo-drifty"].map((plugin) => pinnedReference(root, plugin));
    expect(controls(root, references)).toEqual([
      "demo-drifty@1.0.0 Authorized",
      "demo-stable@1.0.0 Authorized",
    ]);

    drift(root);

    // The version delta is the part a human can act on; two hashes are not.
    expect(controls(root, references)).toEqual([
      "demo-drifty@2.0.0 Reauthorize (authorized at 1.0.0)",
      "demo-stable@1.0.0 Authorized",
    ]);
  });

  it("refuses to run outside the dev-host mirror, so the tracked fixture cannot drift", () => {
    const source = path.join(FIXTURES, "agent-capability-reauth-dogfood");
    expect(() => execFileSync("sh", [path.join(source, "drift.sh")], { stdio: "pipe" })).toThrow();
    expect(fs.readFileSync(path.join(source, ".tachyon/plugins.lock.json"), "utf8")).toContain('"version": "1.0.0"');
  });
});

describe("agent-config-blast-radius fixture (t-588644)", () => {
  /** Set up one agent exactly as authorizing a single plugin in the Studio would. */
  function agent(root: string, name: string, agentId: string, plugin: string) {
    const reference = pinnedReference(root, plugin);
    const dir = path.join(root, ".tachyon", "agents", name);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId,
      runtime: { adapter: "codex", executable: "codex" },
      capabilities: { skills: [plugin] },
      references: [reference],
    }));
    fs.writeFileSync(path.join(dir, "agent.yml"), bytes);
    return [name, {
      schemaVersion: 1, agentName: name, agentId, revision: "profile-r1",
      canonicalSha256: sha256(bytes), runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
      capabilityGrants: [{ kind: "skill", referenceId: plugin, sourceSha256: reference.sha256, adapter: "codex" }],
    } as unknown as AgentProfileAuthorityRecord] as const;
  }

  function scenario() {
    const root = mirror("agent-config-blast-radius");
    return {
      root,
      input: {
        yamlText: "agents:\n"
          + "  bystander:\n    profile: .tachyon/agents/bystander/agent.yml\n"
          + "  pinned:\n    profile: .tachyon/agents/pinned/agent.yml\n",
        workspaceRoot: root,
        authorities: new Map([
          agent(root, "bystander", "11111111-1111-4111-8111-111111111111", "demo-stable"),
          agent(root, "pinned", "22222222-2222-4222-8222-222222222222", "demo-drifty"),
        ]),
        homeDir: makeTempDir("blast-home-"),
      },
    };
  }

  it("starts from a clean roster — otherwise the drift proves nothing", () => {
    const { input } = scenario();
    const before = loadProfileAwareConfig(input);

    expect(Object.keys(before.config!.agents).sort()).toEqual(["bystander", "pinned"]);
    expect(before.profileErrors).toEqual([]);
  });

  it("refuses only the agent whose plugin moved, and keeps the other one loading", () => {
    const { root, input } = scenario();
    drift(root);

    const after = loadProfileAwareConfig(input);
    expect(Object.keys(after.config!.agents)).toEqual(["bystander"]);
    expect(after.profileErrors.join("\n")).toContain("agents.pinned.profile: profile/digest-mismatch");
    // `bystander` authorized a plugin too. Surviving because it held nothing would prove the wrong
    // thing — that agents with no references are safe, not that isolation is per agent.
    expect(after.profileErrors.join("\n")).not.toContain("bystander");
    // t-0ad300 — and `pinned` is still NAMED, which is what puts its row back on the roster. The
    // README's pass criterion depends on this: without it the agent vanishes and Agent Studio, the
    // only place the pin is repaired, becomes unreachable.
    expect(after.config!.agentSources.pinned).toMatchObject({
      mode: "refused",
      reason: expect.stringContaining("profile/digest-mismatch"),
    });
  });

  it("still reports every isolated failure in `errors`, so a validity check refuses what it did before", () => {
    const { root, input } = scenario();
    drift(root);

    const after = loadProfileAwareConfig(input);
    expect(after.errors).toEqual(after.profileErrors);
    expect(after.errors.length).toBeGreaterThan(0);
  });
});
