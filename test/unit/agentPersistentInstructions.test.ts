import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PERSISTENT_INSTRUCTIONS_MAX_CHARS,
  persistentInstructionsFormValue,
  persistentInstructionsRefusal,
  persistentInstructionsText,
  studioOwnsPersistentInstructions,
  studioPersistentInstructionsId,
} from "@tachyon/shared/config/agentInstructionsDocument.js";
import {
  mergedPersistentInstructionsReferences,
  persistentInstructionsWriteFor,
} from "../../src/config/agentInstructionsWrite.js";
import { patchProfileFromStudioMutation } from "@tachyon/shared/config/agentProfileStudio.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileV1 } from "../../src/config/agentProfileSchema.js";
import { MATERIALIZED_PROFILE_REFERENCE_KINDS } from "../../src/config/agentProfileMaterialization.js";

const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

function profile(over: Partial<AgentProfileV1> = {}): AgentProfileV1 {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    ...over,
  } as AgentProfileV1;
}

function snapshot(current: AgentProfileV1): AgentProfileLifecycleSnapshot {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "reviewer",
    agentId: AGENT_ID,
    revision: "a".repeat(64),
    profile: current,
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "d".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 },
      projection: { scope: "runtime", writable: false, active: true },
    },
  };
}

function mutation(instructions: string) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-instance" as const,
    agentName: "reviewer",
    expectedRevision: "a".repeat(64),
    editable: {
      displayName: "",
      runtime: { adapter: "codex", executable: "codex" },
      cwd: "",
      lifecycle: { autostart: false, restart: "never" as const, attention: true },
      worktree: { enabled: false, branch: "", setup: [] },
      instructions,
      isolation: "" as const,
    },
  };
}

describe("t-d48775 — the persistent-instructions document contract", () => {
  it("publishes the fixed id, its bytes and its digest, and publishes nothing for a blank field", () => {
    const write = persistentInstructionsWriteFor({ instructions: "review the diff" });
    expect(write.artifacts).toEqual([
      { path: "instructions.md", text: "review the diff\n", sha256: sha256("review the diff\n") },
    ]);
    expect(write.localReferences).toEqual([{
      id: "persistent-instructions", kind: "instructions", path: "instructions.md",
      mode: "pinned", sha256: sha256("review the diff\n"),
    }]);
    expect(persistentInstructionsWriteFor({ instructions: "   \n " }))
      .toEqual({ artifacts: [], localReferences: [] });
  });

  it("round-trips the form value through the document bytes without dirtying an untouched form", () => {
    const authored = "line one\nline two";
    expect(persistentInstructionsText(authored)).toBe("line one\nline two\n");
    expect(persistentInstructionsFormValue(persistentInstructionsText(authored))).toBe(authored);
    // Windows line endings and trailing blank lines normalize on the way in, so re-saving an
    // unedited form republishes the same digest instead of minting a revision nobody asked for.
    expect(persistentInstructionsText("line one\r\nline two\n\n\n")).toBe("line one\nline two\n");
  });

  it("refuses at the door what the resolver would refuse at spawn, and only that", () => {
    expect(persistentInstructionsRefusal("")).toBeUndefined();
    expect(persistentInstructionsRefusal("ok")).toBeUndefined();
    expect(persistentInstructionsRefusal("a\0b")).toContain("NUL");
    expect(persistentInstructionsRefusal("x".repeat(PERSISTENT_INSTRUCTIONS_MAX_CHARS + 1))).toContain("limit");
    // The byte ceiling is separate from the character one: four-byte scalars hit it first.
    expect(persistentInstructionsRefusal("🙂".repeat(17_000))).toContain("bytes");
    expect(() => persistentInstructionsWriteFor({ instructions: "a\0b" })).toThrow("NUL");
  });

  /**
   * A binding published by someone else must survive the form untouched, in BOTH directions: the
   * writer must not overwrite its document, and a save from a form that renders it blank must not
   * clear it. The dangerous shape is the second one — the human sees an empty box, presses Save, and
   * silently erases instructions they were never shown.
   */
  it("neither overwrites nor clears a binding this Studio does not own", () => {
    const foreign = profile({
      prompt: { instructions: "someone-elses-instructions" },
      references: [{
        id: "someone-elses-instructions", kind: "instructions", scope: "profile", owner: AGENT_ID,
        path: "instructions.md", mode: "pinned", sha256: sha256("foreign\n"),
      }],
    });
    expect(studioOwnsPersistentInstructions(foreign.prompt)).toBe(false);
    expect(persistentInstructionsWriteFor({ instructions: "mine" }, foreign.prompt))
      .toEqual({ artifacts: [], localReferences: [] });
    expect(studioPersistentInstructionsId({ instructions: "", current: foreign.prompt }))
      .toBe("someone-elses-instructions");
    expect(patchProfileFromStudioMutation(mutation(""), snapshot(foreign)).prompt)
      .toEqual({ instructions: "someone-elses-instructions" });
  });

  it("clears its own binding when the field is emptied, and keeps every other reference", () => {
    const owned = profile({
      prompt: { instructions: "persistent-instructions" },
      references: [
        { id: "persistent-instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256("old\n") },
      ],
    });
    const patched = patchProfileFromStudioMutation(mutation(""), snapshot(owned));
    expect(patched.prompt).toBeUndefined();
    const merged = mergedPersistentInstructionsReferences(owned, persistentInstructionsWriteFor({ instructions: "" }, owned.prompt));
    expect(merged.map((reference) => reference.id)).toEqual([]);

    // And re-authoring puts exactly one entry back, stamped with this agent's ownership.
    const rewritten = mergedPersistentInstructionsReferences(owned, persistentInstructionsWriteFor({ instructions: "new" }, owned.prompt));
    expect(rewritten).toEqual([
      { id: "persistent-instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256("new\n") },
    ]);
    expect(patchProfileFromStudioMutation(mutation("new"), snapshot(owned)).prompt)
      .toEqual({ instructions: "persistent-instructions" });
  });

  it("chains over the reference list the other Studio writers produced instead of rebuilding it", () => {
    // The bug this guards is silent: rebuilding from `current.references` would drop the setup
    // reference the workspace-command writer had just added in the same save.
    const current = profile();
    const base = [{
      id: "workspace-setup", kind: "worktree-setup" as const, scope: "profile" as const, owner: AGENT_ID,
      path: "workspace-setup", mode: "pinned" as const, sha256: sha256("npm ci\n"),
    }];
    const merged = mergedPersistentInstructionsReferences(current, persistentInstructionsWriteFor({ instructions: "hello" }), base);
    expect(merged.map((reference) => reference.id)).toEqual(["workspace-setup", "persistent-instructions"]);
  });

  it("is a materialized kind, so the resolver carries its bytes and the projection does not refuse it", () => {
    expect([...MATERIALIZED_PROFILE_REFERENCE_KINDS].sort()).toEqual(["instructions", "worktree-setup"]);
    // `memory` stays out: it is the lane whose whole point is per-item human approval.
    expect(MATERIALIZED_PROFILE_REFERENCE_KINDS.has("memory")).toBe(false);
  });
});
