import { describe, expect, it } from "vitest";
import {
  composeHygieneLineageSource,
  resolveHygieneAuthority,
  type HygieneLineageSource,
} from "@tachyon/engine/worktree/hygieneAuthority.js";
import type { ManagedWorktreeEntry } from "@tachyon/engine/worktree/managedWorktree.js";

/**
 * t-e74631 — WHO may ask for a change worktree to be cleaned up.
 *
 * The incident: 19 change worktrees accumulated, 14 clean and already in the trunk, because removal
 * authority stopped at the creator. The coordinator that delegated the work could not clean up after
 * its own children, and a child that finished its task never wakes up to do it itself.
 *
 * These cases are about AUTHORITY only. That the removal is safe is `classify.ts`'s question, proved
 * separately in worktreeHygieneReconcile.test.ts — the split matters, because widening who may ask is
 * only defensible while every material proof still has to pass.
 */

function lineageOf(pairs: Record<string, string>): HygieneLineageSource {
  return { parentOf: (name) => pairs[name] };
}

function entry(over: Partial<ManagedWorktreeEntry> = {}): ManagedWorktreeEntry {
  return {
    id: "mw-change-t-1",
    kind: "change",
    path: "/w/change/t-1",
    branch: "tachyon/change/t-1",
    baseRef: "main",
    tachyonCreatedBranch: true,
    createdBy: "worker",
    createdAt: "2026-07-28T00:00:00.000Z",
    status: "active",
    ...over,
  };
}

describe("hygiene authority (t-e74631)", () => {
  it("grants the creator, as it always did", () => {
    const decision = resolveHygieneAuthority(entry(), { kind: "agent", name: "worker" }, lineageOf({}));
    expect(decision).toMatchObject({ allowed: true, relation: "owner", actor: "worker", owner: "worker" });
  });

  it("grants the delegating parent — the case that was accumulating residue", () => {
    // This is the whole point of the task: `coordinator` spawned `worker`, so it may clean up after it.
    const decision = resolveHygieneAuthority(entry(), { kind: "agent", name: "coordinator" }, lineageOf({ worker: "coordinator" }));
    expect(decision).toMatchObject({ allowed: true, relation: "ancestor", actor: "coordinator", owner: "worker" });
    // The chain is RECORDED, not just checked: lineage is session-local, so a later reader cannot
    // re-derive what it looked like at removal time.
    expect(decision).toMatchObject({ lineage: ["worker", "coordinator"] });
  });

  it("grants a grandparent, because authority follows the whole chain and not one hop", () => {
    const decision = resolveHygieneAuthority(
      entry(),
      { kind: "agent", name: "root" },
      lineageOf({ worker: "coordinator", coordinator: "root" }),
    );
    expect(decision).toMatchObject({ allowed: true, relation: "ancestor", lineage: ["worker", "coordinator", "root"] });
  });

  it("refuses an unrelated agent, and names who could do it instead", () => {
    const decision = resolveHygieneAuthority(
      entry(),
      { kind: "agent", name: "stranger" },
      lineageOf({ worker: "coordinator" }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    // t-2600f8 — a refusal that does not name a reachable way out is how someone ends up at raw git.
    expect(decision.reason).toContain("coordinator");
    expect(decision.reason).toContain("host UI");
  });

  it("refuses a DESCENDANT: authority runs up the chain, never down it", () => {
    // The child of the owner is not entitled to delete its parent's checkout. Getting this backwards
    // would let a spawned helper remove the worktree its delegator is still working in.
    const decision = resolveHygieneAuthority(
      entry({ createdBy: "coordinator" }),
      { kind: "agent", name: "worker" },
      lineageOf({ worker: "coordinator" }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("grants the host human without consulting lineage at all", () => {
    // An unreadable or empty lineage must never cost the human their own cleanup.
    const thrower: HygieneLineageSource = { parentOf: () => { throw new Error("lineage unavailable"); } };
    expect(resolveHygieneAuthority(entry(), { kind: "human" }, thrower)).toMatchObject({
      allowed: true, relation: "workspace",
    });
  });

  it("refuses legacy/external principals, which are shared tokens rather than an identity", () => {
    for (const kind of ["legacy", "external"]) {
      const decision = resolveHygieneAuthority(entry(), { kind }, lineageOf({}));
      expect(decision.allowed, `${kind} must not carry hygiene authority`).toBe(false);
    }
    // An agent principal with no name is the same problem wearing the right kind.
    expect(resolveHygieneAuthority(entry(), { kind: "agent" }, lineageOf({})).allowed).toBe(false);
  });

  it("never extends lineage to an AGENT worktree, which is a home rather than residue", () => {
    // Project guidance: preserve the persistent agent worktree unconditionally. A parent tidying up
    // after a finished task must not be able to delete the place its child actually lives.
    const home = entry({ id: "mw-agent-worker", kind: "agent", agent: "worker", createdBy: "worker" });
    const decision = resolveHygieneAuthority(home, { kind: "agent", name: "coordinator" }, lineageOf({ worker: "coordinator" }));
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toContain("agent worktree");
    // Its own agent still may, and so may the human.
    expect(resolveHygieneAuthority(home, { kind: "agent", name: "worker" }, lineageOf({})).allowed).toBe(true);
    expect(resolveHygieneAuthority(home, { kind: "human" }, lineageOf({})).allowed).toBe(true);
  });

  /**
   * t-621613 — the one exception to the arm above, and the reason it is not a hole in it. The
   * behavioural half (a real checkout, branch and registry entry) is worktreeOrphanAgentHome.test.ts;
   * these cases pin the decision itself, including the two defaults that keep it narrow.
   */
  describe("an agent home with no inhabitant", () => {
    const home = () => entry({ id: "mw-agent-ghost", kind: "agent", agent: "ghost", createdBy: undefined });

    it("grants any agent caller once the agent is PROVED gone, and says so as `orphan`", () => {
      const decision = resolveHygieneAuthority(home(), { kind: "agent", name: "stranger" }, lineageOf({}), "absent");
      expect(decision).toMatchObject({ allowed: true, relation: "orphan", actor: "stranger", owner: "ghost" });
    });

    it("refuses on `present` and on `unknown` alike — absence has to be measured", () => {
      for (const presence of ["present", "unknown"] as const) {
        const decision = resolveHygieneAuthority(home(), { kind: "agent", name: "stranger" }, lineageOf({}), presence);
        expect(decision.allowed, `presence '${presence}' must not grant`).toBe(false);
        if (decision.allowed) throw new Error("unreachable");
        expect(decision.reason).toContain("agent worktree");
      }
    });

    it("defaults to `unknown`, so every call site that does not measure keeps the old refusal", () => {
      expect(resolveHygieneAuthority(home(), { kind: "agent", name: "stranger" }, lineageOf({})).allowed).toBe(false);
    });

    it("reads the INHABITANT, never the creator, when deciding whose absence matters", () => {
      // `createdBy` answers "who made this"; that agent can be long gone while the agent that LIVES
      // here is still working. Deciding on the creator would delete a live child's home the moment
      // its delegator finished — precisely the outcome the surrounding refusal exists to prevent.
      // A caller measures presence of `entry.agent`; a decision that granted here would mean the
      // module had read `createdBy` instead.
      const delegated = entry({ id: "mw-agent-worker", kind: "agent", agent: "worker", createdBy: "dead-delegator" });
      const live = resolveHygieneAuthority(delegated, { kind: "agent", name: "stranger" }, lineageOf({}), "present");
      expect(live.allowed).toBe(false);
      // And when the inhabitant IS gone, the grant names the inhabitant rather than the creator.
      const gone = resolveHygieneAuthority(delegated, { kind: "agent", name: "stranger" }, lineageOf({}), "absent");
      expect(gone).toMatchObject({ allowed: true, relation: "orphan", owner: "worker" });
    });

    it("refuses an agent entry that names no agent at all, even when told `absent`", () => {
      // Nothing was measured about anybody: there is no name whose absence could have been proved.
      const nameless = entry({ id: "mw-agent-nameless", kind: "agent", agent: undefined, createdBy: undefined });
      expect(resolveHygieneAuthority(nameless, { kind: "agent", name: "stranger" }, lineageOf({}), "absent").allowed).toBe(false);
    });

    it("does not hand orphanhood to legacy/external principals, which are still not an identity", () => {
      for (const kind of ["legacy", "external"]) {
        expect(resolveHygieneAuthority(home(), { kind }, lineageOf({}), "absent").allowed).toBe(false);
      }
      expect(resolveHygieneAuthority(home(), { kind: "agent" }, lineageOf({}), "absent").allowed).toBe(false);
    });
  });

  describe("fail-closed on identity, because an unprovable relation is not a relation", () => {
    it("refuses when the entry records no owner at all", () => {
      // Without this an ownerless row would be removable by ANY agent — wider than the creator-only
      // rule this replaces, which would make the fix a regression rather than a widening.
      const orphan = entry({ createdBy: undefined, agent: undefined });
      const decision = resolveHygieneAuthority(orphan, { kind: "agent", name: "coordinator" }, lineageOf({}));
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("unreachable");
      expect(decision.reason).toContain("records no owner");
    });

    it("refuses a CYCLIC lineage instead of walking it or truncating it", () => {
      const decision = resolveHygieneAuthority(
        entry(),
        { kind: "agent", name: "coordinator" },
        lineageOf({ worker: "coordinator", coordinator: "worker" }),
      );
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("unreachable");
      expect(decision.reason).toContain("cyclic");
    });

    it("refuses when the lineage source throws, because unknown lineage is not absent lineage", () => {
      const decision = resolveHygieneAuthority(
        entry(),
        { kind: "agent", name: "coordinator" },
        { parentOf: () => { throw new Error("ledger unreadable"); } },
      );
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("unreachable");
      expect(decision.reason).toContain("unreadable");
    });

    it("refuses a pathologically deep chain rather than hanging inside an authorization decision", () => {
      const deep: HygieneLineageSource = { parentOf: (name) => `${name}x` };
      const decision = resolveHygieneAuthority(entry(), { kind: "agent", name: "nowhere" }, deep);
      expect(decision.allowed).toBe(false);
    });
  });
});

/**
 * t-ff0a7a — governed Saved Agents expose declaredOwner without a runtime parent. Hygiene must
 * treat that declared owner as an authorized ancestor for CHANGE residue only.
 */
describe("hygiene authority + declaredOwner (t-ff0a7a)", () => {
  const declaredOnly = composeHygieneLineageSource({
    runtimeParentOf: () => undefined,
    declaredOwnerOf: (name) => (name === "grok-builder" || name === "codex-builder" ? "codex-canonico" : undefined),
  });

  it("grants the declaredOwner of a Saved Agent so the coordinator can sweep its change worktrees", () => {
    // Fail-before: parentOf was runtime-only, so "owner has no recorded parent" refused codex-canonico.
    const decision = resolveHygieneAuthority(
      entry({ createdBy: "grok-builder" }),
      { kind: "agent", name: "codex-canonico" },
      declaredOnly,
    );
    expect(decision).toMatchObject({
      allowed: true,
      relation: "ancestor",
      actor: "codex-canonico",
      owner: "grok-builder",
      lineage: ["grok-builder", "codex-canonico"],
    });
  });

  it("still refuses an agent with no runtime parent and no declaredOwner", () => {
    const decision = resolveHygieneAuthority(
      entry({ createdBy: "stranger-builder" }),
      { kind: "agent", name: "codex-canonico" },
      declaredOnly,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toMatch(/no recorded parent|neither the owner/);
  });

  it("prefers runtime parent over declaredOwner when both exist", () => {
    const both = composeHygieneLineageSource({
      runtimeParentOf: (name) => (name === "worker" ? "session-parent" : undefined),
      declaredOwnerOf: (name) => (name === "worker" ? "config-owner" : undefined),
    });
    const bySession = resolveHygieneAuthority(entry(), { kind: "agent", name: "session-parent" }, both);
    const byConfig = resolveHygieneAuthority(entry(), { kind: "agent", name: "config-owner" }, both);
    expect(bySession).toMatchObject({ allowed: true, relation: "ancestor", lineage: ["worker", "session-parent"] });
    // Config owner is NOT on the walk once runtime parent is present — edges stay ordered, not unioned.
    expect(byConfig.allowed).toBe(false);
  });

  it("still never extends declaredOwner authority to an agent worktree home", () => {
    const home = entry({ id: "mw-agent-grok", kind: "agent", agent: "grok-builder", createdBy: "grok-builder" });
    const decision = resolveHygieneAuthority(home, { kind: "agent", name: "codex-canonico" }, declaredOnly);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toContain("agent worktree");
  });

  it("composeHygieneLineageSource ignores self-parent and empty declared values", () => {
    const src = composeHygieneLineageSource({
      runtimeParentOf: () => "self",
      declaredOwnerOf: (name) => (name === "self" ? "self" : ""),
    });
    // runtime parent equals name is ignored; declaredOwner self/empty ignored → no parent.
    expect(src.parentOf("self")).toBeUndefined();
  });
});
