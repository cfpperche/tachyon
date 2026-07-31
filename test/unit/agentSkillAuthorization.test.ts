import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  authorizeWorkspaceSkill,
  revokeWorkspaceSkill,
  skillReferenceIdFor,
  type SkillAuthorizationState,
} from "../../src/config/agentSkillAuthorization.js";

/**
 * t-5498a6 — authorizing a workspace skill, which nobody could do before.
 *
 * The profile model already refused every selection that was not host-authorized, and no door existed
 * to authorize anything — so every profile in this workspace grants zero skills by unreachability
 * rather than by decision. These tests hold the rules of the door that opens.
 */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const empty: SkillAuthorizationState = { references: [], grants: [] };

function visualQa(overrides: Partial<{ path: string; sha256: string; owner: string }> = {}) {
  return {
    adapter: "claude",
    skill: {
      path: ".claude/skills/visual-qa",
      sha256: DIGEST_A,
      owner: "plugin:visual-qa",
      ...overrides,
    },
  };
}

describe("t-5498a6 — authorizing is granting the RIGHT to select, never the selection", () => {
  it("produces a pinned project reference and its matching grant", () => {
    const result = authorizeWorkspaceSkill(empty, visualQa());

    expect(result.ok && result.outcome).toBe("authorized");
    expect(result.ok && result.state.references[0]).toEqual({
      id: "visual-qa",
      kind: "skill",
      scope: "project",
      owner: "plugin:visual-qa",
      path: ".claude/skills/visual-qa",
      mode: "pinned",
      sha256: DIGEST_A,
    });
    expect(result.ok && result.state.grants[0]).toEqual({
      referenceId: "visual-qa",
      sourceSha256: DIGEST_A,
      adapter: "claude",
      kind: "skill",
    });
  });

  it("returns ONLY grant state — a caller cannot accidentally receive a selection from here", () => {
    // The split is the whole governance model: "may have" and "has" are separate facts, decided at
    // separate moments. A result carrying `capabilities.skills` would let one call do both.
    const result = authorizeWorkspaceSkill(empty, visualQa());

    expect(result.ok && Object.keys(result.state).sort()).toEqual(["grants", "references"]);
  });

  it("derives the id from the skill directory, so two humans authorize the SAME thing once", () => {
    // A caller-chosen id would let the same skill accumulate duplicate grants under different handles,
    // and then "already authorized" silently stops detecting anything.
    expect(skillReferenceIdFor(".claude/skills/visual-qa")).toBe("visual-qa");
    expect(skillReferenceIdFor(".agents/skills/dep-audit/")).toBe("dep-audit");
  });
});

describe("t-5498a6 — a pinned capability cannot change underneath the person who approved it", () => {
  it("is idempotent at the same digest", () => {
    const first = authorizeWorkspaceSkill(empty, visualQa());
    expect(first.ok).toBe(true);

    const again = authorizeWorkspaceSkill(first.ok ? first.state : empty, visualQa());

    expect(again.ok && again.outcome).toBe("unchanged");
    expect(again.ok && again.state).toEqual(first.ok && first.state);
  });

  it("REFUSES to re-pin a changed skill silently, and writes nothing until told to", () => {
    // The load-bearing case. `visual-qa` at a new digest is not the skill that was approved; the pin
    // exists exactly so it cannot quietly become something else between approval and run.
    const first = authorizeWorkspaceSkill(empty, visualQa());
    const changed = authorizeWorkspaceSkill(first.ok ? first.state : empty, visualQa({ sha256: DIGEST_B }));

    expect(changed.ok && changed.outcome).toBe("digest-changed");
    expect(changed.ok && changed.state.references[0]?.sha256).toBe(DIGEST_A);

    const accepted = authorizeWorkspaceSkill(
      first.ok ? first.state : empty,
      visualQa({ sha256: DIGEST_B }),
      { reauthorize: true },
    );
    expect(accepted.ok && accepted.outcome).toBe("reauthorized");
    expect(accepted.ok && accepted.state.references[0]?.sha256).toBe(DIGEST_B);
    expect(accepted.ok && accepted.state.references).toHaveLength(1);
    expect(accepted.ok && accepted.state.grants).toHaveLength(1);
  });

  it("refuses to move an approved handle onto a different source", () => {
    const first = authorizeWorkspaceSkill(empty, visualQa());
    const moved = authorizeWorkspaceSkill(
      first.ok ? first.state : empty,
      visualQa({ path: ".agents/skills/visual-qa" }),
    );

    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.error).toContain("already points at");
  });
});

describe("t-5498a6 — an unsupported runtime refuses LOUDLY instead of granting nothing", () => {
  it("names Grok's missing grant record rather than failing a schema later", () => {
    // The failure this shape prevents is the one t-62f599 was: a policy expressible for some runtimes
    // and silently inert for another. Grok is absent from the grant enum; that must be a stated
    // refusal at the door, not an opaque validation error further down.
    const result = authorizeWorkspaceSkill(empty, { ...visualQa(), adapter: "grok" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("grok");
    expect(!result.ok && result.error).toContain("cannot hold a skill grant yet");
  });

  it("refuses to re-grant an existing reference to a different runtime", () => {
    const first = authorizeWorkspaceSkill(empty, visualQa());
    const swapped = authorizeWorkspaceSkill(first.ok ? first.state : empty, { ...visualQa(), adapter: "codex" });

    expect(swapped.ok).toBe(false);
    expect(!swapped.ok && swapped.error).toContain("already granted for 'claude'");
  });
});

describe("t-5498a6 — the inputs a workspace path must never carry", () => {
  it("refuses escaping, absolute and malformed paths", () => {
    for (const bad of ["../outside/skill", "/etc/skill", "~/skills/x", ".claude/skills/../../etc", ""]) {
      const result = authorizeWorkspaceSkill(empty, visualQa({ path: bad }));
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("refuses a digest that is not a lowercase SHA-256", () => {
    for (const bad of ["", "A".repeat(64), "abc", `${DIGEST_A}0`]) {
      expect(authorizeWorkspaceSkill(empty, visualQa({ sha256: bad })).ok).toBe(false);
    }
  });

  it("requires provenance, because a reference exists to say where content came from", () => {
    expect(authorizeWorkspaceSkill(empty, visualQa({ owner: "   " })).ok).toBe(false);
  });
});

describe("t-5498a6 — revoking has to take the selection with it", () => {
  it("names the ids the caller must also deselect, instead of leaving an invalid profile", () => {
    // A revoked grant while `capabilities.skills` still lists it produces a profile the Studio itself
    // rejects. Naming that here beats a caller finding out from a validation failure.
    const first = authorizeWorkspaceSkill(empty, visualQa());
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
    for (const adapter of ["claude", "codex", "pi"]) {
      expect(adapters![1], `${adapter} is no longer a grantable adapter`).toContain(`"${adapter}"`);
    }
    // The refusal above is only honest while grok is genuinely absent from the enum.
    expect(adapters![1]).not.toContain('"grok"');

    const result = authorizeWorkspaceSkill(empty, visualQa());
    const grantKinds = /kind: z\.enum\(\[([^\]]*)\]\)/.exec(authority);
    expect(grantKinds![1]).toContain(`"${result.ok ? result.state.grants[0]!.kind : ""}"`);

    const schema = fs.readFileSync(path.join(process.cwd(), "src/config/agentProfileSchema.ts"), "utf8");
    expect(schema).toContain('scope: z.enum(["profile", "project", "product"])');
    expect(schema).toContain('mode: z.enum(["pinned", "floating"])');
  });
});
