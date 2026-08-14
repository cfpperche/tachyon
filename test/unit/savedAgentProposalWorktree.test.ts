import { describe, expect, it } from "vitest";
import {
  proposedWorktreeEnabled,
  savedAgentCreateMutation,
  REFUSED_PROPOSAL_WORKSPACE_KEYS,
  type SavedAgentProposalSpec,
} from "@tachyon/engine/agents/savedAgentProposal.js";
import {
  createProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  DEFAULT_NEW_AGENT_WORKTREE_ENABLED,
} from "@tachyon/shared/config/agentProfileStudio.js";
import type { AgentProfileLifecycleSnapshot } from "@tachyon/engine/config/agentProfileLifecycle.js";
import { canonicalAgentFields } from "../../src/webview/agent-studio-shell/domain.js";
import { branchFor, resolveBase } from "@tachyon/engine/worktree/WorktreeManager.js";

/**
 * t-4071e4 — a proposed Saved Agent runs in its own governed worktree by default.
 *
 * The bug: the approval path hardcoded `worktree: { enabled: false }`, so an agent created through the
 * governed door came out LESS isolated than one a human made by hand, and nothing on the approval
 * screen said so. These tests follow one proposal from spec to materialized branch, because the halves
 * that can disagree (spec, persisted profile, reload projection, start) are in four different modules.
 */

function spec(overrides: Partial<SavedAgentProposalSpec> = {}): SavedAgentProposalSpec {
  return { name: "importer", runtimeAdapter: "codex", rationale: "needed", ...overrides };
}

/** The profile the lifecycle transaction actually writes for an approved proposal. */
function createdProfile(overrides: Partial<SavedAgentProposalSpec> = {}) {
  return createProfileFromStudioMutation(savedAgentCreateMutation("importer", spec(overrides)));
}

/** Reload: what the Studio reads back from a committed profile. */
function reloaded(profile: ReturnType<typeof createdProfile>) {
  const snapshot: AgentProfileLifecycleSnapshot = {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "importer",
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision: "b".repeat(64),
    profile: { schemaVersion: 1, agentId: "123e4567-e89b-42d3-a456-426614174000", ...profile },
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 },
      learned: { scope: "profile", writable: false, present: false },
      projection: { scope: "runtime", writable: false, active: false },
    },
  } as unknown as AgentProfileLifecycleSnapshot;
  return projectAgentProfileStudioSnapshot(snapshot);
}

describe("t-4071e4 — a proposed Saved Agent is isolated by default, end to end", () => {
  it("persists the separate worktree when the proposal says nothing at all", () => {
    const profile = createdProfile();

    expect(proposedWorktreeEnabled(spec())).toBe(DEFAULT_NEW_AGENT_WORKTREE_ENABLED);
    expect(profile.workspace?.worktree?.enabled).toBe(true);
    // The spec's `workspace` is absent here, so this proves the DEFAULT is written, not an echo.
    expect(spec().workspace).toBeUndefined();
  });

  it("persists the shared checkout only when the proposal explicitly opted out", () => {
    const profile = createdProfile({ workspace: { worktree: false } });

    // Off is represented by absence of the worktree block, not by `enabled: false`: one representation
    // per state, so a legacy shared-checkout profile and an opted-out one are the same thing on disk.
    expect(profile.workspace?.worktree).toBeUndefined();
    expect(reloaded(profile).editable.worktree.enabled).toBe(false);
  });

  it("survives a reload — the Studio reads back the isolation it was created with", () => {
    const projected = reloaded(createdProfile());

    expect(projected.editable.worktree.enabled).toBe(true);
    // Reload must not silently re-default: the human can turn it off and have that stick.
    expect(reloaded(createdProfile({ workspace: { worktree: false } })).editable.worktree.enabled).toBe(false);
  });

  it("leaves the checkout LOCATION entirely to the host, so isolation cannot be aimed", () => {
    const profile = createdProfile();

    // `branch` and `cwd` are the two fields that would let a proposal choose where it lands. Neither
    // is written, so `branchFor` falls through to the workspace template or the host default, and the
    // worktrees root comes from global settings the proposer never sees.
    expect(profile.workspace?.worktree?.branch).toBeUndefined();
    expect(profile.workspace?.cwd).toBeUndefined();

    expect(branchFor("importer", {}, { branch: undefined })).toBe("tachyon/importer");
    expect(branchFor("importer", { worktree: { branch: "wt/{agent}" } }, { branch: undefined })).toBe("wt/importer");
    // A proposer-supplied branch would win here if it had ever reached the profile — it cannot.
    expect(branchFor("importer", {}, { branch: "attacker/main" })).toBe("attacker/main");

    expect(resolveBase({ worktree: { base: "/governed/root" } })).toBe("/governed/root");
    for (const key of REFUSED_PROPOSAL_WORKSPACE_KEYS) {
      expect(JSON.stringify(profile)).not.toContain(key === "cwd" ? '"cwd"' : `"${key}"`);
    }
  });

  it("creates enabled but starts nothing, so isolation is not a session either", () => {
    const profile = createdProfile();

    // t-ca9086: approving writes an ENABLED profile. Being isolated by default must not turn that
    // into a launch — there is no autostart, so no session and no worktree exists until a human starts it.
    expect(profile.lifecycle?.enabled).toBe(true);
    expect(profile.lifecycle?.autostart).toBeUndefined();
    expect(profile.capabilities).toBeUndefined();
  });

  it("agrees with the Studio's own new-agent form, which is the door this one drifted from", () => {
    // The asymmetry that opened this task was between doors, so the assertion is between doors.
    expect(canonicalAgentFields().worktree).toBe(true);
    expect(canonicalAgentFields().branch).toBe("");
    expect(createdProfile().workspace?.worktree?.enabled).toBe(canonicalAgentFields().worktree);

    // Editing an EXISTING agent still shows that agent's real posture — the default is for new only.
    const existing = reloaded(createdProfile({ workspace: { worktree: false } }));
    expect(canonicalAgentFields(existing).worktree).toBe(false);
  });
});
