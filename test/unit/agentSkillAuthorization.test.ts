import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  authorizeWorkspaceSkill,
  revokeWorkspaceSkill,
  skillReferenceIdFor,
  type SkillAuthorizationState,
  type SkillOrigin,
} from "../../src/config/agentSkillAuthorization.js";

/**
 * t-5498a6 — authorizing a skill, which nobody could do before.
 *
 * The profile model already refused every selection that was not host-authorized, and no door existed
 * to authorize anything — so every profile in this workspace grants zero skills by unreachability
 * rather than by decision. These tests hold the rules of the door that opens.
 */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const empty: SkillAuthorizationState = { references: [], grants: [] };

const pluginOrigin = (overrides: Partial<Extract<SkillOrigin, { kind: "plugin" }>> = {}): SkillOrigin => ({
  kind: "plugin",
  plugin: "visual-qa",
  skill: "visual-qa",
  version: "0.3.1",
  runtimes: ["claude", "codex"],
  ...overrides,
});

describe("t-5498a6 — authorizing is granting the RIGHT to select, never the selection", () => {
  it("returns ONLY grant state — a caller cannot accidentally receive a selection from here", () => {
    // The split is the whole governance model: "may have" and "has" are separate facts, decided at
    // separate moments. A result carrying `capabilities.skills` would let one call do both.
    const result = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });

    expect(result.ok && Object.keys(result.state).sort()).toEqual(["grants", "references"]);
  });

  it("derives the id from the skill itself, so two humans authorize the SAME thing once", () => {
    // A caller-chosen id would let the same skill accumulate duplicate grants under different handles,
    // and then "already authorized" silently stops detecting anything.
    expect(skillReferenceIdFor(pluginOrigin())).toBe("visual-qa");
    expect(skillReferenceIdFor({ kind: "workspace", path: ".claude/skills/dep-audit/" })).toBe("dep-audit");
    expect(skillReferenceIdFor({ kind: "runtime-home", runtime: "claude", name: "imagine", profileRelativePath: "skills/imagine" })).toBe("imagine");
  });
});

/**
 * The three origins are not interchangeable. Each pins a different thing and fails differently, and
 * collapsing them is how a plugin upgrade would surface as an unexplained content change.
 */
describe("t-5498a6 — a plugin skill is pinned at its SOURCE, not at the copy the installer wrote", () => {
  it("points the reference at the plugin tree and carries the plugin version", () => {
    // `.claude/skills/visual-qa` is a byte-identical COPY the installer produced. Pinning the copy
    // would make the reference describe a derivative and lose the version entirely.
    const result = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });

    expect(result.ok && result.outcome).toBe("authorized");
    expect(result.ok && result.state.references[0]).toEqual({
      id: "visual-qa",
      kind: "skill",
      scope: "project",
      owner: "plugin:visual-qa",
      path: ".tachyon/plugins/visual-qa/skills/visual-qa",
      mode: "pinned",
      sha256: DIGEST_A,
      version: "0.3.1",
    });
    expect(result.ok && result.state.grants[0]).toEqual({
      referenceId: "visual-qa",
      sourceSha256: DIGEST_A,
      adapter: "claude",
      kind: "skill",
    });
  });

  it("refuses a runtime the plugin's manifest does not install for, and names what it does install for", () => {
    // Measured: product-foundation declares runtimes:[claude] and genuinely has no .agents/skills copy.
    // Authorizing it for codex would grant a capability the installer would never deliver.
    const result = authorizeWorkspaceSkill(empty, {
      adapter: "codex",
      origin: pluginOrigin({ plugin: "product-foundation", skill: "product-foundation", version: "0.1.1", runtimes: ["claude"] }),
      sha256: DIGEST_A,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("does not declare runtime 'codex'");
    expect(!result.ok && result.error).toContain("claude");
  });

  it("treats a plugin version bump as a change needing a decision, even at the same digest", () => {
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const bumped = authorizeWorkspaceSkill(first.ok ? first.state : empty, {
      adapter: "claude",
      origin: pluginOrigin({ version: "0.4.0" }),
      sha256: DIGEST_A,
    });

    expect(bumped.ok && bumped.outcome).toBe("digest-changed");
    expect(bumped.ok && bumped.state.references[0]?.version).toBe("0.3.1");
  });
});

describe("t-5498a6 — a hand-written workspace skill carries its provenance in the digest alone", () => {
  it("is project-scoped with no version, because there is no upstream to name", () => {
    const result = authorizeWorkspaceSkill(empty, {
      adapter: "claude",
      origin: { kind: "workspace", path: ".claude/skills/house-style" },
      sha256: DIGEST_A,
    });

    expect(result.ok && result.state.references[0]).toEqual({
      id: "house-style",
      kind: "skill",
      scope: "project",
      owner: "workspace",
      path: ".claude/skills/house-style",
      mode: "pinned",
      sha256: DIGEST_A,
    });
  });
});

describe("t-5498a6 — a skill from the user's runtime home is pinned as a COPY, never in place", () => {
  it("is profile-scoped and owned by the agent, which is what the schema demands", () => {
    // Measured: `scope: "project"` resolves against the workspace root and nothing resolves against a
    // user home, so a global skill cannot be referenced where it lives. Copying and pinning is also
    // the safer fact: a skill in ~/.grok/skills can change without Tachyon ever seeing it.
    const result = authorizeWorkspaceSkill(empty, {
      adapter: "claude",
      agentId: "claude-validador",
      origin: { kind: "runtime-home", runtime: "grok", name: "imagine", profileRelativePath: "skills/imagine" },
      sha256: DIGEST_A,
    });

    expect(result.ok && result.state.references[0]).toEqual({
      id: "imagine",
      kind: "skill",
      scope: "profile",
      owner: "claude-validador",
      path: "skills/imagine",
      mode: "pinned",
      sha256: DIGEST_A,
    });
  });

  it("refuses without an agentId instead of writing an owner the schema would reject", () => {
    const result = authorizeWorkspaceSkill(empty, {
      adapter: "claude",
      origin: { kind: "runtime-home", runtime: "grok", name: "imagine", profileRelativePath: "skills/imagine" },
      sha256: DIGEST_A,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("agentId");
  });

  it("tells the caller to delete the orphaned copy when the authorization is withdrawn", () => {
    // Nothing else would ever remove it: the tree lives in the profile directory because Tachyon put
    // it there, so revoking the record without the copy leaves content nobody accounts for.
    const first = authorizeWorkspaceSkill(empty, {
      adapter: "claude",
      agentId: "claude-validador",
      origin: { kind: "runtime-home", runtime: "grok", name: "imagine", profileRelativePath: "skills/imagine" },
      sha256: DIGEST_A,
    });
    const revoked = revokeWorkspaceSkill(first.ok ? first.state : empty, "imagine");

    expect(revoked.removed).toBe(true);
    expect(revoked.removedCopy).toBe("skills/imagine");
  });

  it("does not report a copy to delete for a project-scoped reference Tachyon never placed", () => {
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const revoked = revokeWorkspaceSkill(first.ok ? first.state : empty, "visual-qa");

    expect(revoked.removed).toBe(true);
    expect(revoked.removedCopy).toBeUndefined();
  });
});

describe("t-5498a6 — a pinned capability cannot change underneath the person who approved it", () => {
  it("is idempotent at the same digest", () => {
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    expect(first.ok).toBe(true);

    const again = authorizeWorkspaceSkill(first.ok ? first.state : empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });

    expect(again.ok && again.outcome).toBe("unchanged");
    expect(again.ok && again.state).toEqual(first.ok && first.state);
  });

  it("REFUSES to re-pin a changed skill silently, and writes nothing until told to", () => {
    // The load-bearing case. `visual-qa` at a new digest is not the skill that was approved; the pin
    // exists exactly so it cannot quietly become something else between approval and run.
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const changed = authorizeWorkspaceSkill(first.ok ? first.state : empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_B });

    expect(changed.ok && changed.outcome).toBe("digest-changed");
    expect(changed.ok && changed.state.references[0]?.sha256).toBe(DIGEST_A);

    const accepted = authorizeWorkspaceSkill(
      first.ok ? first.state : empty,
      { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_B },
      { reauthorize: true },
    );
    expect(accepted.ok && accepted.outcome).toBe("reauthorized");
    expect(accepted.ok && accepted.state.references[0]?.sha256).toBe(DIGEST_B);
    expect(accepted.ok && accepted.state.references).toHaveLength(1);
    expect(accepted.ok && accepted.state.grants).toHaveLength(1);
  });

  it("refuses to move an approved handle onto a different source", () => {
    // The same skill NAME reached by a different origin is a different source. Silently repointing
    // would move a human's approval onto content they never saw.
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const moved = authorizeWorkspaceSkill(first.ok ? first.state : empty, {
      adapter: "claude",
      origin: { kind: "workspace", path: ".claude/skills/visual-qa" },
      sha256: DIGEST_A,
    });

    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.error).toContain("already points at");
  });
});

describe("t-84c678 — Grok holds exact per-agent skill grants", () => {
  it("authorizes a Grok skill at the pinned source used by private-home projection", () => {
    const result = authorizeWorkspaceSkill(empty, {
      adapter: "grok",
      origin: pluginOrigin({ runtimes: ["claude", "codex", "grok"] }),
      sha256: DIGEST_A,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.state.grants).toEqual([{
      referenceId: "visual-qa",
      sourceSha256: DIGEST_A,
      adapter: "grok",
      kind: "skill",
    }]);
  });

  it("refuses to re-grant an existing reference to a different runtime", () => {
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const swapped = authorizeWorkspaceSkill(first.ok ? first.state : empty, { adapter: "codex", origin: pluginOrigin(), sha256: DIGEST_A });

    expect(swapped.ok).toBe(false);
    expect(!swapped.ok && swapped.error).toContain("already granted for 'claude'");
  });
});

describe("t-5498a6 — the inputs a custody path must never carry", () => {
  it("refuses escaping, absolute and malformed paths", () => {
    for (const bad of ["../outside/skill", "/etc/skill", "~/skills/x", ".claude/skills/../../etc", ""]) {
      const result = authorizeWorkspaceSkill(empty, {
        adapter: "claude",
        origin: { kind: "workspace", path: bad },
        sha256: DIGEST_A,
      });
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("refuses a digest that is not a lowercase SHA-256", () => {
    for (const bad of ["", "A".repeat(64), "abc", `${DIGEST_A}0`]) {
      expect(authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: bad }).ok).toBe(false);
    }
  });
});

describe("t-5498a6 — revoking has to take the selection with it", () => {
  it("names the ids the caller must also deselect, instead of leaving an invalid profile", () => {
    // A revoked grant while `capabilities.skills` still lists it produces a profile the Studio itself
    // rejects. Naming that here beats a caller finding out from a validation failure.
    const first = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const revoked = revokeWorkspaceSkill(first.ok ? first.state : empty, "visual-qa", ["visual-qa", "sdd"]);

    expect(revoked.removed).toBe(true);
    expect(revoked.state.references).toHaveLength(0);
    expect(revoked.state.grants).toHaveLength(0);
    expect(revoked.alsoDeselect).toEqual(["visual-qa"]);
  });

  it("reports a no-op revoke as such rather than pretending it did something", () => {
    const revoked = revokeWorkspaceSkill(empty, "never-granted");
    expect(revoked.removed).toBe(false);
    expect(revoked.alsoDeselect).toEqual([]);
  });
});

/**
 * t-5498a6 — the records this module emits must satisfy the schemas that persist them. Hand-written
 * literals here would drift from `agentProfileAuthority.ts` / `agentProfileSchema.ts` without any test
 * noticing, and the failure would surface as a write rejection far from this file.
 */
describe("t-5498a6 — emitted records match the persisted schemas", () => {
  it("uses the grant adapters and the reference kind the schemas actually accept", () => {
    const authority = fs.readFileSync(path.join(process.cwd(), "src/config/agentProfileAuthority.ts"), "utf8");
    const adapters = /adapter: z\.enum\(\[([^\]]*)\]\)/.exec(authority);
    expect(adapters).toBeTruthy();
    for (const adapter of ["claude", "codex", "grok", "pi"]) {
      expect(adapters![1], `${adapter} is no longer a grantable adapter`).toContain(`"${adapter}"`);
    }

    const result = authorizeWorkspaceSkill(empty, { adapter: "claude", origin: pluginOrigin(), sha256: DIGEST_A });
    const grantKinds = /kind: z\.enum\(\[([^\]]*)\]\)/.exec(authority);
    expect(grantKinds![1]).toContain(`"${result.ok ? result.state.grants[0]!.kind : ""}"`);

    const schema = fs.readFileSync(path.join(process.cwd(), "src/config/agentProfileSchema.ts"), "utf8");
    expect(schema).toContain('scope: z.enum(["profile", "project", "product"])');
    expect(schema).toContain('mode: z.enum(["pinned", "floating"])');
  });

  it("honours the schema rule that a profile-scoped reference is owned by its own agent", () => {
    // agentProfileSchema.ts refines: scope === "profile" requires owner === profile.agentId. A copied
    // runtime-home skill is the only origin that lands there, so the rule is enforced at this door.
    const schema = fs.readFileSync(path.join(process.cwd(), "src/config/agentProfileSchema.ts"), "utf8");
    expect(schema).toContain('reference.scope === "profile" && reference.owner !== profile.agentId');

    const result = authorizeWorkspaceSkill(empty, {
      adapter: "claude",
      agentId: "claude-builder",
      origin: { kind: "runtime-home", runtime: "grok", name: "imagine", profileRelativePath: "skills/imagine" },
      sha256: DIGEST_A,
    });
    expect(result.ok && result.state.references[0]!.owner).toBe("claude-builder");
  });
});
