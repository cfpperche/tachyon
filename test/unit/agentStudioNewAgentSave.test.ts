import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canSave } from "@tachyon/webview-ui/webview/shared/studio/dirtyGating.js";
import {
  canonicalAgentFields,
  computeAgentDirty,
  newAgentCommandRefusal,
  newAgentNameRefusal,
  newAgentRuntimeRefusal,
  serializeAgentPatch,
  type AgentStudioEntity,
  type AgentStudioFields,
} from "@tachyon/webview-ui/webview/agent-studio-shell/domain.js";
import {
  createProfileFromStudioMutation,
  DEFAULT_NEW_AGENT_WORKTREE_ENABLED,
  type AgentProfileStudioMutationV1,
} from "@tachyon/shared/config/agentProfileStudio.js";

/**
 * t-093a0d + t-7e4225 — New Agent Save: why it greys, and where it lives.
 *
 * The owner saw Save dead with worktree ON and live with it OFF. That is dirty-gating against a
 * creation default of worktree-on, not a worktree validity lock. The defect is the silent button:
 * name and command are required by the door and were not named on screen. Create Save then moves
 * to the last wizard step; edit keeps the header.
 */

const root = path.resolve(__dirname, "../..");

function readSrc(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function loadedNew(): { entity: Pick<AgentStudioEntity, "fields">; fields: AgentStudioFields } {
  const fields = canonicalAgentFields();
  return { entity: { fields: canonicalAgentFields() }, fields };
}

describe("t-093a0d — Save is locked by dirtiness and unnamed required fields, not by worktree", () => {
  it("loads a new agent with worktree ON, matching the creation default, and that document is clean", () => {
    const { entity, fields } = loadedNew();
    expect(DEFAULT_NEW_AGENT_WORKTREE_ENABLED).toBe(true);
    expect(fields.worktree).toBe(true);
    expect(computeAgentDirty(entity as AgentStudioEntity, fields)).toBe(false);
  });

  it("unchecking worktree is the first dirt — the screenshot pair, with no validity change", () => {
    const { entity, fields } = loadedNew();
    expect(computeAgentDirty(entity as AgentStudioEntity, { ...fields, worktree: false })).toBe(true);
    expect(newAgentNameRefusal({ ...fields, worktree: false })).toBeDefined();
    expect(newAgentCommandRefusal({ ...fields, worktree: false })).toBeDefined();
  });

  it("names the missing name and command on a pristine create, including after the worktree toggle", () => {
    const fields = canonicalAgentFields();
    expect(newAgentNameRefusal(fields)).toMatch(/name before saving/i);
    expect(newAgentCommandRefusal(fields)).toMatch(/runtime command before saving/i);
    expect(newAgentNameRefusal({ ...fields, worktree: false })).toBeDefined();
    expect(newAgentCommandRefusal({ ...fields, worktree: false })).toBeDefined();
  });

  it("does not enable Save when the only change is unchecking worktree", () => {
    const { entity, fields } = loadedNew();
    const toggled = { ...fields, worktree: false };
    const blockers = [newAgentNameRefusal(toggled), newAgentCommandRefusal(toggled), newAgentRuntimeRefusal(toggled)]
      .filter((message) => message !== undefined).length;
    expect(canSave({
      dirty: computeAgentDirty(entity as AgentStudioEntity, toggled),
      blockingErrorCount: blockers,
      saveInFlight: false,
      concurrencyStale: false,
    })).toBe(false);
  });

  it("clears the name and command refusals only when both match the door, even with worktree still on", () => {
    const filled: AgentStudioFields = { ...canonicalAgentFields(), name: "helper", cmd: "claude" };
    expect(filled.worktree).toBe(true);
    expect(newAgentNameRefusal(filled)).toBeUndefined();
    expect(newAgentCommandRefusal(filled)).toBeUndefined();
    expect(newAgentRuntimeRefusal(filled)).toBeUndefined();
  });

  it("refuses an illegal name with the same rule the create door uses", () => {
    const illegal = { ...canonicalAgentFields(), name: "1bad", cmd: "claude" };
    expect(newAgentNameRefusal(illegal)).toMatch(/start with a letter/);
    const patch = serializeAgentPatch(illegal, true) as AgentProfileStudioMutationV1;
    expect(() => createProfileFromStudioMutation(patch)).toThrow();
    const legal = serializeAgentPatch({ ...canonicalAgentFields(), name: "helper", cmd: "claude" }, true) as AgentProfileStudioMutationV1;
    expect(() => createProfileFromStudioMutation(legal)).not.toThrow();
  });

  it("stays silent on an existing profile, so edit is not trapped by the create identity rules", () => {
    const existing = { ...canonicalAgentFields(), name: "", cmd: "" };
    existing.canonical!.expectedRevision = "a".repeat(64);
    expect(newAgentNameRefusal(existing)).toBeUndefined();
    expect(newAgentCommandRefusal(existing)).toBeUndefined();
  });
});

describe("t-093a0d / t-7e4225 — guards: reason stays visible, Save stays off the create header", () => {
  it("New Agent feeds name and command refusals into the blocking errors the frame shows", () => {
    const src = withoutComments(readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx"));
    expect(src).toContain("newAgentNameRefusal");
    expect(src).toContain("newAgentCommandRefusal");
    expect(src).toContain("validation/agent-name");
    expect(src).toContain("validation/agent-command");
    expect(src).toMatch(/errors: StudioError\[\] = \[[\s\S]*nameRefusalError[\s\S]*commandRefusalError/);
    expect(src).toContain("nameRefusalError ? 1 : 0");
    expect(src).toContain("commandRefusalError ? 1 : 0");
  });

  it("create omits header Save and renders it on the last wizard step; edit keeps the header", () => {
    const src = withoutComments(readSrc("packages/webview-ui/src/webview/agent-studio-shell/App.tsx"));
    expect(src).toContain('omitHeaderSave={mode === "new"}');
    const navAt = src.indexOf('class="ash-steps-nav"');
    expect(navAt).toBeGreaterThan(-1);
    const nav = src.slice(navAt, navAt + 1200);
    expect(nav).toContain("wizardSteps.length - 1");
    expect(nav).toContain("DEFAULT_STUDIO_LABELS.save");
    expect(nav).toContain("onSave");
    const frame = withoutComments(readSrc("packages/webview-ui/src/webview/shared/studio/StudioFrame.tsx"));
    expect(frame).toContain("omitHeaderSave");
    expect(frame).toContain("!props.omitHeaderSave");
  });
});
