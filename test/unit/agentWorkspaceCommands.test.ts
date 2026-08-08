import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  MATERIALIZED_WORKSPACE_REFERENCE_KINDS,
  WORKSPACE_SETUP_PATH,
  WORKSPACE_SETUP_REFERENCE_ID,
  WORKSPACE_VERIFY_PATH,
  WORKSPACE_VERIFY_REFERENCE_ID,
  parseWorkspaceCommandLines,
  studioOwnsWorkspaceCommands,
  studioWorkspaceCommandIds,
} from "../../src/config/agentWorkspaceCommands.js";
import { mergedWorkspaceCommandReferences, workspaceCommandWriteFor } from "../../src/config/agentWorkspaceCommandWrite.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "../../src/config/agentProfileSchema.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR, projectCanonicalAgentProfile } from "../../src/config/agentProfileProjection.js";
import { exportPortableAgentProfileBundle } from "../../src/config/agentProfileBundle.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileStudioEditableV1 } from "../../src/config/agentProfileStudio.js";

/**
 * t-afc86e — an agent's own verify gate and worktree setup commands, made authorable.
 *
 * Both were consumed and unwritable: `effectiveVerify` resolves per-agent over global, the Bridge's
 * `verify_agent` door and `wait_for_agent`'s "ready AND green" both read the gate, `runWorktreeSetup`
 * runs the setup list — and no authoring path could produce either. The Studio rendered them
 * permanently disabled under a hint promising a binding no task carried, and the projection refused
 * the whole profile with "verification/setup references are not materialized yet".
 *
 * The knot was smaller than it read. Measured before any code: the canonical schema ALREADY accepted
 * profile-scoped `verification` / `worktree-setup` references and the resolver ALREADY read them,
 * digest-checked them and carried the ids through. Only two things were missing — the resolver
 * discarded the bytes it had just verified, and the projection refused instead of materializing.
 *
 * The end-to-end round trip (write, reopen, save untouched, value survives) is in
 * `workspaceHeadless.test.ts`, driven through the real Workspace. This suite owns the contract
 * underneath it: what the bytes look like, who owns a reference, and what happens to a field this
 * Studio did not write.
 */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const digest = (value: string | Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function editable(over: Partial<AgentProfileStudioEditableV1> = {}): Pick<AgentProfileStudioEditableV1, "verify" | "worktree"> {
  return {
    verify: "",
    worktree: { enabled: true, branch: "", setup: [] },
    ...over,
  } as Pick<AgentProfileStudioEditableV1, "verify" | "worktree">;
}

/** A profile on disk with both documents pinned, exactly as the writer produces them. */
function writtenProfile(over: { verify?: string; setup?: string[] } = {}): { root: string; profile: AgentProfileV1 } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-commands-"));
  roots.push(root);
  const dir = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(dir, { recursive: true });
  const verify = over.verify ?? "pytest packages/api";
  const setup = over.setup ?? ["python -m venv .venv", "pip install -e ."];
  const write = workspaceCommandWriteFor(editable({ verify, worktree: { enabled: true, branch: "", setup } }));
  for (const artifact of write.artifacts) fs.writeFileSync(path.join(dir, artifact.path), artifact.text);
  const ids = studioWorkspaceCommandIds({ verify, setup });
  const profile = {
    schemaVersion: 1 as const,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    workspace: {
      ...(ids.verify ? { verify: ids.verify } : {}),
      worktree: { enabled: true, ...(ids.setup.length > 0 ? { setup: ids.setup } : {}) },
    },
    references: write.localReferences.map((reference) => ({ ...reference, scope: "profile" as const, owner: AGENT_ID })),
  };
  fs.writeFileSync(path.join(dir, "agent.yml"), stringify(profile));
  return { root, profile: agentProfileSchemaV1.parse(profile) };
}

describe("t-afc86e — the bytes a saved verify gate produces", () => {
  it("writes one file per field, with the setup file holding one command per line", () => {
    const write = workspaceCommandWriteFor(editable({
      verify: "  pytest packages/api  ",
      worktree: { enabled: true, branch: "", setup: ["python -m venv .venv", "  pip install -e .  ", "   "] },
    }));
    expect(write.artifacts).toEqual([
      { path: WORKSPACE_VERIFY_PATH, text: "pytest packages/api\n", sha256: digest("pytest packages/api\n") },
      { path: WORKSPACE_SETUP_PATH, text: "python -m venv .venv\npip install -e .\n", sha256: digest("python -m venv .venv\npip install -e .\n") },
    ]);
    // One reference for the whole setup list, not one per command. N artifacts would have needed N
    // allowlisted names, and therefore a ceiling (`setup-0..setup-7`) nobody chose — which becomes an
    // unexplainable refusal the day someone writes the ninth command.
    expect(write.localReferences.map((reference) => [reference.id, reference.kind])).toEqual([
      [WORKSPACE_VERIFY_REFERENCE_ID, "verification"],
      [WORKSPACE_SETUP_REFERENCE_ID, "worktree-setup"],
    ]);
    for (const reference of write.localReferences) {
      const artifact = write.artifacts.find((entry) => entry.path === reference.path)!;
      expect(reference.sha256, "a pin must match the bytes published beside it").toBe(artifact.sha256);
      expect(reference.mode).toBe("pinned");
    }
  });

  it("writes nothing for a field the human cleared — that is how a gate is removed", () => {
    expect(workspaceCommandWriteFor(editable())).toEqual({ artifacts: [], localReferences: [] });
    expect(workspaceCommandWriteFor(editable({ verify: "   " }))).toEqual({ artifacts: [], localReferences: [] });
  });

  it("rebuilds the reference list rather than appending, so clearing really removes the pin", () => {
    const current = {
      schemaVersion: 1 as const,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      references: [
        { id: "soul", kind: "soul" as const, scope: "profile" as const, owner: AGENT_ID, path: "SOUL.md", mode: "pinned" as const, sha256: "b".repeat(64) },
        { id: WORKSPACE_VERIFY_REFERENCE_ID, kind: "verification" as const, scope: "profile" as const, owner: AGENT_ID, path: WORKSPACE_VERIFY_PATH, mode: "pinned" as const, sha256: "c".repeat(64) },
      ],
    };
    const cleared = mergedWorkspaceCommandReferences(current, workspaceCommandWriteFor(editable()));
    // The Studio owns two ids and nothing else: Soul survives, its own pin goes.
    expect(cleared.map((reference) => reference.id)).toEqual(["soul"]);

    const rewritten = mergedWorkspaceCommandReferences(current, workspaceCommandWriteFor(editable({ verify: "npm test" })));
    expect(rewritten.map((reference) => reference.id)).toEqual(["soul", WORKSPACE_VERIFY_REFERENCE_ID]);
    expect(rewritten.find((reference) => reference.id === WORKSPACE_VERIFY_REFERENCE_ID)?.sha256)
      .toBe(digest("npm test\n"));
  });
});

describe("t-afc86e — the projection materializes what the resolver read", () => {
  it("turns the pinned references into the command strings the runtime entry carries", () => {
    const { root } = writtenProfile();
    const file = path.join(root, ".tachyon", "agents", "codex", "agent.yml");
    const result = projectCanonicalAgentProfile({
      workspaceRoot: root,
      agentName: "codex",
      authority: {
        schemaVersion: 1,
        agentName: "codex",
        agentId: AGENT_ID,
        revision: "r1",
        canonicalSha256: digest(fs.readFileSync(file)),
        runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
      },
    } as never);
    expect(result.ok, result.ok ? "" : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    // Red before the fix: "profile/projection: verification/setup references are not materialized yet".
    expect(result.definition.verify).toBe("pytest packages/api");
    expect(result.definition.worktreeSetup).toEqual(["python -m venv .venv", "pip install -e ."]);
  });

  it("carries text only for the kinds it materializes, never for a prompt lane", () => {
    // Soul and instructions are formation lanes delivered under their own authority. Carrying their
    // bytes through the resolved reference would put prompt content into a value that is passed
    // around, digested and logged for entirely different reasons.
    expect([...MATERIALIZED_WORKSPACE_REFERENCE_KINDS].sort()).toEqual(["verification", "worktree-setup"]);
  });
});

describe("t-afc86e — a reference this Studio did not write is left alone", () => {
  it("reports ownership by the fixed reference id", () => {
    expect(studioOwnsWorkspaceCommands({})).toEqual({ verify: true, setup: true });
    expect(studioOwnsWorkspaceCommands({ verify: WORKSPACE_VERIFY_REFERENCE_ID, setup: [WORKSPACE_SETUP_REFERENCE_ID] }))
      .toEqual({ verify: true, setup: true });
    expect(studioOwnsWorkspaceCommands({ verify: "workspace-published-verifier" }))
      .toEqual({ verify: false, setup: true });
  });

  it("preserves a foreign id instead of clearing it, whatever the form sends", () => {
    // The form disables the field and shows nothing for a foreign reference, so the mutation arrives
    // carrying a blank. Writing that blank back would delete a value the human was never shown —
    // which is precisely the failure this whole slice exists to avoid, in its other direction.
    const ids = studioWorkspaceCommandIds({
      verify: "",
      setup: [],
      current: { verify: "workspace-published-verifier", setup: ["workspace-published-setup"] },
    });
    expect(ids).toEqual({ verify: "workspace-published-verifier", setup: ["workspace-published-setup"] });
    expect(workspaceCommandWriteFor(editable({ verify: "sneaky overwrite" }), {
      verify: "workspace-published-verifier",
      worktree: { setup: ["workspace-published-setup"] },
    })).toEqual({ artifacts: [], localReferences: [] });
  });
});

describe("t-afc86e — a bundle does not lose them silently", () => {
  it("exports them as reauthorization requirements rather than dropping them", () => {
    // A portable bundle carries no workspace posture by design, so verify and setup do not travel.
    // What matters is that their absence is REPORTED: `requiresReauthorization` is the bundle's
    // contract for "this did not come with you, declare it again", and a clone that quietly lost a
    // verify gate would hand someone a green badge that measured nothing.
    const { root, profile } = writtenProfile();
    const snapshot = {
      schemaVersion: 1,
      canonicalizationVersion: 1,
      agentName: "codex",
      agentId: AGENT_ID,
      revision: "a".repeat(64),
      profile,
      provenance: {
        canonical: { scope: "profile", writable: true, sha256: digest(fs.readFileSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))) },
        authority: { scope: "host", writable: false, revision: "r1", grants: 0 },
        learned: { scope: "profile", writable: false, present: false },
        projection: { scope: "runtime", writable: false, active: true },
      },
    } as unknown as AgentProfileLifecycleSnapshot;
    const exported = exportPortableAgentProfileBundle({ workspaceRoot: root, snapshot });
    const fields = exported.bundle.requiresReauthorization.map((requirement) => requirement.field);
    expect(fields).toContain("workspace");
    expect(fields).toContain(`references.${WORKSPACE_VERIFY_REFERENCE_ID}`);
    expect(fields).toContain(`references.${WORKSPACE_SETUP_REFERENCE_ID}`);
    expect(JSON.stringify(exported.bundle.profile)).not.toContain("pytest packages/api");
  });
});

describe("t-afc86e — command-line parsing", () => {
  it("drops blank lines and trims, so formatting is not a command", () => {
    expect(parseWorkspaceCommandLines("npm test\n\n  cargo test  \n")).toEqual(["npm test", "cargo test"]);
    expect(parseWorkspaceCommandLines("   \n\n")).toEqual([]);
  });
});
