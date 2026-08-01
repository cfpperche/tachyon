import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeAgentSkill,
  authorizedSkillStates,
  revokeAgentSkill,
  skillOriginFor,
  type SkillAuthorizationPorts,
} from "../../src/config/agentSkillAuthorizationService.js";
import type { AgentProfileV1 } from "../../src/config/agentProfileSchema.js";

/**
 * t-5498a6 — the fs half of the authorization door, and the ONE function both callers reach.
 *
 * The pure core's rules are held in `agentSkillAuthorization.test.ts`. What matters here is what only
 * a real tree can show: that the digest is the one the resolver will verify at delivery, that a
 * plugin skill is discriminated from a hand-written one by the LOCKFILE rather than by content, and
 * that the reference and the grant land in a single commit.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-auth-"));
  dirs.push(dir);
  return dir;
}

function writeSkill(root: string, relative: string, body: string): void {
  const dir = path.join(root, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

function writeLock(root: string, plugins: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tachyon/plugins.lock.json"), JSON.stringify({ schemaVersion: 1, plugins }));
}

function profile(overrides: Partial<AgentProfileV1> = {}): AgentProfileV1 {
  return {
    schemaVersion: 1,
    agentId: "agent-0000",
    runtime: { adapter: "claude", executable: "claude" },
    ...overrides,
  } as AgentProfileV1;
}

function ports(initial: AgentProfileV1, grants: Record<string, unknown>[] = []) {
  const state = { profile: initial, grants: grants as never[], commits: 0 };
  const port: SkillAuthorizationPorts = {
    read: async () => ({ profile: state.profile, grants: state.grants }),
    commit: async ({ references, capabilityGrants, selectedSkills }) => {
      state.commits += 1;
      state.profile = {
        ...state.profile,
        references: [...references],
        ...(selectedSkills ? { capabilities: { ...(state.profile.capabilities ?? {}), skills: [...selectedSkills] } } : {}),
      } as AgentProfileV1;
      state.grants = [...capabilityGrants] as never[];
    },
  };
  return { port, state };
}

describe("t-5498a6 — the reference and the grant land together, at the digest delivery will verify", () => {
  it("pins a plugin skill at the digest of the PLUGIN tree, and writes both records in one commit", async () => {
    const root = workspace();
    writeSkill(root, ".tachyon/plugins/visual-qa/skills/visual-qa", "# visual-qa\n");
    const { port, state } = ports(profile());

    const result = await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude-validador",
      origin: { kind: "plugin", plugin: "visual-qa", skill: "visual-qa", version: "0.3.1", runtimes: ["claude", "codex"] },
      ports: port,
    });

    expect(result.ok && result.outcome).toBe("authorized");
    expect(state.commits).toBe(1);
    const reference = state.profile.references![0]!;
    expect(reference.path).toBe(".tachyon/plugins/visual-qa/skills/visual-qa");
    expect(reference.version).toBe("0.3.1");
    // The grant must carry the SAME digest as the reference; `requireGrant` compares them exactly, so
    // any divergence here would surface at delivery as an unexplained capability refusal.
    expect((state.grants[0] as { sourceSha256: string }).sourceSha256).toBe(reference.sha256);
  });

  it("never selects on its own — selection is the caller's explicit flag, never a side effect", async () => {
    // t-5498a6 — the split lives HERE, not in the number of clicks a human makes. Both product
    // callers now pass `select: true`, because in both the human's gesture already means "give this
    // agent the skill". What must stay impossible is a caller receiving a selection it did not ask
    // for: that is what would let some future path enable a capability nobody chose.
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(profile());

    await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
    });

    expect(state.profile.references).toHaveLength(1);
    expect(state.profile.capabilities?.skills ?? []).toEqual([]);
  });

  it("selects in the SAME transaction when the approval caller asks, because there the human ticked it", async () => {
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(profile());

    const result = await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
      select: true,
    });

    expect(result.ok && result.selected).toBe(true);
    expect(state.profile.capabilities?.skills).toEqual(["house-style"]);
    expect(state.commits).toBe(1);
  });

  it("writes nothing when the same content is authorized twice", async () => {
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(profile());
    const origin = { kind: "workspace", path: ".claude/skills/house-style" } as const;

    await authorizeAgentSkill({ workspaceRoot: root, agentName: "claude", origin, ports: port });
    const again = await authorizeAgentSkill({ workspaceRoot: root, agentName: "claude", origin, ports: port });

    expect(again.ok && again.outcome).toBe("unchanged");
    expect(state.commits).toBe(1);
  });

  it("refuses a changed skill and writes nothing until reauthorize says so", async () => {
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(profile());
    const origin = { kind: "workspace", path: ".claude/skills/house-style" } as const;

    await authorizeAgentSkill({ workspaceRoot: root, agentName: "claude", origin, ports: port });
    const pinned = state.profile.references![0]!.sha256;

    writeSkill(root, ".claude/skills/house-style", "# house, but different\n");
    const changed = await authorizeAgentSkill({ workspaceRoot: root, agentName: "claude", origin, ports: port });

    expect(changed.ok && changed.outcome).toBe("digest-changed");
    expect(state.commits).toBe(1);
    expect(state.profile.references![0]!.sha256).toBe(pinned);

    const accepted = await authorizeAgentSkill({ workspaceRoot: root, agentName: "claude", origin, ports: port, reauthorize: true });
    expect(accepted.ok && accepted.outcome).toBe("reauthorized");
    expect(state.profile.references![0]!.sha256).not.toBe(pinned);
  });

  it("leaves references and grants it never inspected exactly where they were", async () => {
    // Replacing the whole list with what the pure core returned would silently drop mcp, hook and
    // prompt references — the core only ever saw the skills.
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(
      profile({
        references: [{ id: "evolution-selector", kind: "evolution", scope: "profile", owner: "agent-0000", path: "evolution-selector.json", mode: "pinned", sha256: "c".repeat(64) }],
      } as Partial<AgentProfileV1>),
      [{ referenceId: "some-mcp", sourceSha256: "d".repeat(64), adapter: "claude", kind: "mcp" }],
    );

    await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
    });

    expect(state.profile.references!.map((reference) => reference.id).sort()).toEqual(["evolution-selector", "house-style"]);
    expect(state.grants.map((grant: { referenceId: string }) => grant.referenceId).sort()).toEqual(["house-style", "some-mcp"]);
  });
});

describe("t-5498a6 — refusals that must arrive as answers, not as failures", () => {
  it("names the missing tree instead of pinning a digest of nothing", async () => {
    const root = workspace();
    const { port } = ports(profile());

    const result = await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/absent" },
      ports: port,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("profile/missing-reference");
  });

  it("names the missing tree-placement mechanism for a runtime-home skill", async () => {
    // The core supports this origin; the canonical transaction publishes bounded TEXT artifacts and
    // cannot place a tree in the profile directory. Pinning a path that will never hold content would
    // produce a grant that fails at delivery, far from the decision that caused it.
    const root = workspace();
    const { port } = ports(profile());

    const result = await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "runtime-home", runtime: "grok", name: "imagine", profileRelativePath: "skills/imagine" },
      ports: port,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("tree placement does not exist yet");
  });
});

describe("t-5498a6 — the lockfile decides what came from a plugin, not the content", () => {
  it("classifies a plugin skill by its recorded target even after it was edited by hand", async () => {
    // A materialized plugin skill that a human edited diverges from the plugin tree. Comparing
    // content would call it hand-written and pin the wrong source; the lockfile still says whose it is.
    const root = workspace();
    writeLock(root, {
      "visual-qa": {
        name: "visual-qa",
        version: "0.3.1",
        runtimes: ["claude", "codex"],
        targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/visual-qa" }],
      },
    });
    writeSkill(root, ".claude/skills/visual-qa", "# edited by hand\n");

    expect(skillOriginFor(root, "visual-qa", "claude")).toEqual({
      kind: "plugin", plugin: "visual-qa", skill: "visual-qa", version: "0.3.1", runtimes: ["claude", "codex"],
    });
  });

  it("classifies a skill no plugin claims as a workspace skill, per runtime directory", async () => {
    const root = workspace();
    writeLock(root, {});
    writeSkill(root, ".agents/skills/house-style", "# house\n");

    expect(skillOriginFor(root, "house-style", "codex")).toEqual({ kind: "workspace", path: ".agents/skills/house-style" });
    // Same name, a runtime whose directory does not hold it: nothing to authorize rather than a guess.
    expect(skillOriginFor(root, "house-style", "claude")).toBeUndefined();
  });

  it("reports nothing for a name that exists nowhere", async () => {
    const root = workspace();
    writeLock(root, {});
    expect(skillOriginFor(root, "nonexistent", "claude")).toBeUndefined();
  });
});

describe("t-5498a6 — revoking takes the selection with it, in one commit", () => {
  it("drops the reference, the grant and the selection together", async () => {
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    const { port, state } = ports(profile());

    await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
      select: true,
    });
    const revoked = await revokeAgentSkill({ agentName: "claude", referenceId: "house-style", ports: port });

    expect(revoked.ok && revoked.removed).toBe(true);
    expect(revoked.ok && revoked.deselected).toBe(true);
    expect(state.profile.references).toHaveLength(0);
    expect(state.grants).toHaveLength(0);
    expect(state.profile.capabilities?.skills).toEqual([]);
    expect(state.commits).toBe(2);
  });

  it("reports a no-op revoke without touching anything", async () => {
    const { port, state } = ports(profile());
    const revoked = await revokeAgentSkill({ agentName: "claude", referenceId: "never-granted", ports: port });

    expect(revoked.ok && revoked.removed).toBe(false);
    expect(state.commits).toBe(0);
  });
});

describe("t-5498a6 — the digest is the one delivery will verify", () => {
  it("matches what the resolver's own reader computes for the same tree", async () => {
    // If these ever diverge, every grant this door mints is dead on arrival, and the symptom appears
    // as a capability refusal with no connection to this file.
    const { captureCapabilitySourceAtRoot } = await import("../../src/config/agentCapabilitySource.js");
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# house\n");
    fs.writeFileSync(path.join(root, ".claude/skills/house-style/extra.txt"), crypto.randomBytes(32).toString("hex"));
    const { port, state } = ports(profile());

    await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
    });
    const pinned = state.profile.references![0]!.sha256!;

    expect(() => captureCapabilitySourceAtRoot(root, ".claude/skills/house-style", pinned)).not.toThrow();
  });
});

/**
 * t-4a2a6f — the drift detector. It must agree with delivery, because it PREDICTS delivery: a
 * `stale: false` that delivery then refuses would put a "Authorized" label on a broken agent.
 */
describe("t-4a2a6f — classifying what the agent already holds", () => {
  it("agrees with the reader delivery uses, in both directions", async () => {
    const { captureCapabilitySourceAtRoot } = await import("../../src/config/agentCapabilitySource.js");
    const root = workspace();
    writeSkill(root, ".claude/skills/house-style", "# v1\n");
    const { port, state } = ports(profile());

    await authorizeAgentSkill({
      workspaceRoot: root,
      agentName: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      ports: port,
    });
    const references = state.profile.references!;

    expect(authorizedSkillStates(root, references).get("house-style")).toEqual({ stale: false });
    expect(() => captureCapabilitySourceAtRoot(root, ".claude/skills/house-style", references[0]!.sha256!)).not.toThrow();

    // the plugin update: same path, new bytes
    fs.writeFileSync(path.join(root, ".claude/skills/house-style/SKILL.md"), "# v2\n");

    expect(authorizedSkillStates(root, references).get("house-style")).toEqual({ stale: true });
    expect(() => captureCapabilitySourceAtRoot(root, ".claude/skills/house-style", references[0]!.sha256!)).toThrow();
  });

  it("counts a vanished tree as stale — delivery refuses that too, and the repair is the same gesture", () => {
    const root = workspace();
    const references = [{
      id: "gone", kind: "skill" as const, scope: "project" as const, owner: "workspace",
      path: ".claude/skills/gone", mode: "pinned" as const, sha256: "a".repeat(64),
    }];

    expect(authorizedSkillStates(root, references).get("gone")).toEqual({ stale: true });
  });

  it("carries the version forward so the refusal can name the delta instead of two digests", () => {
    const root = workspace();
    writeSkill(root, ".tachyon/plugins/p/skills/p", "# v1\n");
    const references = [{
      id: "p", kind: "skill" as const, scope: "project" as const, owner: "plugin:p",
      path: ".tachyon/plugins/p/skills/p", mode: "pinned" as const, sha256: "a".repeat(64), version: "2.1.2",
    }];

    expect(authorizedSkillStates(root, references).get("p")).toEqual({ version: "2.1.2", stale: true });
  });

  it("ignores references that are not pinned skills — an mcp or hook reference has no tree to compare", () => {
    const root = workspace();
    const references = [
      { id: "some-mcp", kind: "mcp" as const, scope: "project" as const, owner: "workspace", path: "x", mode: "pinned" as const, sha256: "a".repeat(64) },
    ];

    expect(authorizedSkillStates(root, references as never).size).toBe(0);
  });
});
