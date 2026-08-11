import { describe, expect, it } from "vitest";
import {
  agentProfileStudioEditableSchemaV1,
  createProfileFromStudioMutation,
  patchProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  type AgentProfileStudioMutationV1,
} from "../../src/config/agentProfileStudio.js";
import { agentProfileSchemaV1 } from "../../src/config/agentProfileSchema.js";
import { canonicalAgentFields, serializeAgentPatch } from "../../src/webview/agent-studio-shell/domain.js";
import { savedAgentCreateMutation } from "../../src/agents/savedAgentProposal.js";
import { toEntry, type FormState } from "../../src/webview/formLogic.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";
import { upsertAgent } from "../../src/config/YamlConfigEditor.js";
import { blankAgentFields } from "../../src/webview/agent-studio-shell/domain.js";

/**
 * t-bd14d8 — `watch` is a Terminal capability. This suite measures the AUTHORING half: no Agent door
 * accepts one, a profile that already carries one keeps loading, and the Terminal side is untouched.
 * The half that ACTS on a watch — `Workspace.rebuildWatches` registering a watcher, and the warning
 * the human gets — is measured end-to-end through a real Workspace in `workspaceHeadless.test.ts`.
 *
 * Why it is a boundary defect and not a cosmetic one: a watch hit runs
 * `restart(agent, { stop: "force", session: "new" })`. For `bun run dev` that is the whole feature.
 * For an Agent it force-kills the session and opens a blank one because a file was saved, discarding
 * transcript and work in progress with no human gesture.
 *
 * The compat side is `strip with warning`, never refusal (the owner's t-48dd8d rule: invalid config
 * warns and does not trap). An agent that vanished from the roster over a stale key would be a worse
 * outcome than a watch that stopped firing, so `agentProfileSchemaV1` still READS the field.
 */

const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REVISION = "b".repeat(64);

function storedProfile(watch?: string[]) {
  return {
    schemaVersion: 1 as const,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    lifecycle: {
      enabled: true,
      autostart: true,
      restart: "on-crash" as const,
      attention: { enabled: true, silenceSec: 12 },
      ...(watch ? { watch } : {}),
    },
  };
}

/** The same shape `agentProfileStudio.test.ts` builds — a full lifecycle snapshot, watch optional. */
function lifecycleSnapshot(watch?: string[]): AgentProfileLifecycleSnapshot {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "reviewer",
    agentId: AGENT_ID,
    revision: REVISION,
    profile: storedProfile(watch),
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "d".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 },
      projection: { scope: "runtime", writable: false, active: false },
    },
  };
}

function mutation(expectedRevision?: string): AgentProfileStudioMutationV1 {
  return {
    schemaVersion: 1,
    kind: "agent-instance",
    agentName: "reviewer",
    ...(expectedRevision ? { expectedRevision } : {}),
    editable: {
      displayName: "",
      runtime: { adapter: "codex", executable: "codex" },
      cwd: "",
      lifecycle: { autostart: false, restart: "never", attention: true },
      worktree: { enabled: false, branch: "", setup: [] },
      instructions: "",
      isolation: "",
      capabilities: { skills: [], mcp: [], hooks: [] },
    },
  };
}

describe("t-bd14d8 — no Agent authoring door carries a watch", () => {
  it("the editable schema REFUSES a lifecycle.watch instead of dropping it", () => {
    // Strict on purpose: a key the product will not author should fail at the door. Silently
    // discarding it is how the terminal form spent a year offering four keys nothing ever read.
    const withWatch = mutation();
    (withWatch.editable.lifecycle as unknown as Record<string, unknown>).watch = ["src/**"];
    const parsed = agentProfileStudioEditableSchemaV1.safeParse(withWatch.editable);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain("watch");
  });

  it("the Studio form neither reads nor writes one", () => {
    // Read: a stored watch never reaches the form, because there is no control to render or clear it.
    const snapshot = projectAgentProfileStudioSnapshot(lifecycleSnapshot(["src/**"]));
    expect(snapshot.editable.lifecycle).not.toHaveProperty("watch");
    const fields = canonicalAgentFields(snapshot);
    expect(fields.watch).toBe("");

    // Write: even a FormState carrying a watch (a stale state, a shared blank) emits none.
    const patch = serializeAgentPatch({ ...canonicalAgentFields(), name: "helper", cmd: "codex", watch: "src/**" }, true);
    expect(patch).toMatchObject({ kind: "agent-instance" });
    expect((patch as AgentProfileStudioMutationV1).editable.lifecycle).not.toHaveProperty("watch");
  });

  it("neither creation door writes one — the Studio's or an agent's proposal", () => {
    expect(createProfileFromStudioMutation(mutation()).lifecycle).not.toHaveProperty("watch");
    // `savedAgentCreateMutation` builds what `propose_saved_agent` hands to the same create door.
    expect(savedAgentCreateMutation("helper", { runtimeAdapter: "codex" }).editable.lifecycle)
      .not.toHaveProperty("watch");
  });

  it("editing an agent STRIPS a stored watch, so the first save is the repair", () => {
    // The patch builder spreads the stored lifecycle forward. Without the explicit delete a legacy
    // watch would survive every edit untouched and keep force-restarting the agent.
    const current = lifecycleSnapshot(["src/**", "package.json"]);
    expect(current.profile.lifecycle).toHaveProperty("watch");
    expect(patchProfileFromStudioMutation(mutation(REVISION), current).lifecycle).not.toHaveProperty("watch");
  });
});

describe("t-bd14d8 — a profile that already has one still loads", () => {
  it("the profile schema still READS lifecycle.watch", () => {
    // Removing the key from this strict object would turn every profile carrying one into a profile
    // that fails to load — the agent would disappear from the roster over a field that no longer
    // does anything. That is the trap t-48dd8d forbids, and this assertion is what holds it open.
    const parsed = agentProfileSchemaV1.safeParse(storedProfile(["src/**"]));
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });
});

describe("t-bd14d8 — the Terminal side is untouched", () => {
  const terminalForm = (): FormState => ({
    ...(blankAgentFields() as FormState),
    name: "dev",
    cmd: "npm run dev",
    kind: "terminal",
    watch: "src/**, package.json",
  });

  it("a terminal form still writes its watch, and the loader still reads it", () => {
    const entry = toEntry(terminalForm());
    expect(entry).toMatchObject({ watch: ["src/**", "package.json"] });
    const yaml = upsertAgent("terminals: {}\n", "dev", entry, undefined, "terminals").text;
    const parsed = parseConfig(yaml);
    expect(parsed.errors).toEqual([]);
    expect(parsed.discarded).toEqual([]);
    expect(parsed.config?.agents.dev).toMatchObject({ kind: "terminal", watch: ["src/**", "package.json"] });
  });
});
