import { describe, expect, it } from "vitest";
import { parseConfig, asAgent } from "../../src/config/loadConfig.js";
import { agentProfileSchemaV1 } from "../../src/config/agentProfileSchema.js";
import { EXTENSION_COMMAND_ACTIONS, EXTENSION_QUERY_ACTIONS } from "../../src/runtime-api/extensionOperations.js";
import { FORMATION_GOVERNED_LANES } from "../../src/agents/formation/sessionPolicy.js";
import { AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES } from "../../src/webview/agent-studio-shell/domain.js";
import { canonicalWorkspaceStudioFormV1 } from "../../src/engine-service/protocol.js";
import { composeAgentPrompt } from "../../src/agents/promptLayers.js";
import { AGENT_FORGET_PLAN_STEP_IDS } from "../../src/config/agentForgetPlan.js";

/**
 * t-8ea8e0 — the product does not know self-evolution any more.
 *
 * Every case below closes an inventory BY IDENTITY: it asserts the exact set a surface accepts,
 * never the absence of the string "evolution". That distinction is the whole point — a test that
 * greps for a literal passes green the moment someone reintroduces the same capability under
 * another name, which is the failure mode this file exists to prevent. Re-adding the machine here
 * means adding a member to one of these sets, and every set below is asserted with `toEqual` on a
 * sorted array, so a new member fails whatever it is called.
 *
 * The sets themselves are read from PRODUCTION values, never re-typed from the source they check.
 */
describe("t-8ea8e0 — self-evolution is not a capability this product has", () => {
  it("the agent config contract accepts exactly this key set, and refuses anything else by name", () => {
    // The loader's accepted keys, measured by running it: every key is offered on one agent and the
    // ones that survive ARE the contract. An opt-in flag for a self-evolving agent has to appear
    // here to work at all, whatever it is called.
    const offered = {
      cmd: "codex",
      cwd: "apps/web",
      env: { A: "1" },
      autostart: true,
      watch: ["src/**"],
      attention: { enabled: true },
      restart: "never",
      kind: "agent",
      instructions: "be helpful",
      worktree: true,
      branch: "feature/x",
      worktreeSetup: "npm ci",
      harness: {},
      isolate: true,
      subagents: ["child"],
    };
    const parsed = parseConfig(JSON.stringify({ agents: { probe: offered } }));
    const agent = asAgent(parsed.config?.agents.probe);
    expect(agent).toBeDefined();

    // The keys that SURVIVE onto the parsed entry are the contract. (`harness: {}`, `isolate` and
    // `subagents` are offered above and normalized away — they are accepted syntax, not stored
    // state — which is exactly why this asserts what the parser KEEPS, not what it was handed.)
    expect(Object.keys(agent!).sort()).toEqual([
      "attention", "autostart", "branch", "cmd", "cwd", "environment",
      "instructions", "kind", "restart", "watch", "worktree", "worktreeSetup",
    ]);

    // And an unknown key is refused BY NAME rather than dropped in silence.
    const refused = parseConfig("agents:\n  probe:\n    cmd: codex\n    selfEvolution: {enabled: true}\n");
    expect(asAgent(refused.config?.agents.probe)).not.toHaveProperty("selfEvolution");
    expect(refused.discarded.some((message) => message.includes("selfEvolution"))).toBe(true);
  });

  it("the canonical profile accepts exactly these reference kinds and prompt bindings", () => {
    // A capability that survives a restart has to be pinned in the profile. These two sets are the
    // only doors into it, so a reintroduced ledger would have to widen one of them.
    const shape = agentProfileSchemaV1._def.schema.shape as Record<string, { _def: unknown }>;
    const promptKeys = Object.keys((shape.prompt as unknown as {
      _def: { innerType: { shape: Record<string, unknown> } };
    })._def.innerType.shape);
    expect(promptKeys.sort()).toEqual(["instructions", "memory"]);

    const accepted = ["instructions", "memory", "skill", "mcp", "hook", "pi-extension", "pi-prompt",
      "pi-theme", "pi-package", "project-guidance", "bridge-guidance", "worktree-setup", "runtime-adapter"];
    for (const kind of accepted) {
      expect(agentProfileSchemaV1.safeParse(profileWithReferenceKind(kind)).success, kind).toBe(true);
    }
    // Any OTHER kind — the shape a resurrected selector would need — is refused outright.
    for (const kind of ["evolution", "learning", "self-improvement", "growth"]) {
      expect(agentProfileSchemaV1.safeParse(profileWithReferenceKind(kind)).success, kind).toBe(false);
    }
  });

  it("the extension operation surface is exactly these actions", () => {
    // The Studio's only route to the host. A human approve/reject gesture for agent-authored
    // content would have to be an action here.
    expect([...EXTENSION_QUERY_ACTIONS].filter((action) => action.startsWith("agent.")).sort())
      .toEqual(["agent.fork-preview", "agent.inspect", "agent.session-inspection", "agent.wait"]);
    expect([...EXTENSION_COMMAND_ACTIONS].length).toBe(new Set(EXTENSION_COMMAND_ACTIONS).size);
    // The complete approve/reject surface. Agent-authored content that a human has to ratify needs
    // a pair here; these two are the Saved Agent proposal and the pipeline gate, and nothing else
    // may join them without this line changing.
    expect([...EXTENSION_COMMAND_ACTIONS].filter((action) => /\.(approve|reject)$/.test(action)).sort())
      .toEqual(["pipeline.approve", "pipeline.reject", "proposal.approve", "proposal.reject"]);
  });

  it("the prompt the product composes carries exactly these layers", () => {
    // The manifest an agent reads about its own session. A catalogue injected at spawn — the shape
    // `renderEvolutionPromptLayer` had — would have to show up as a layer here.
    const composed = composeAgentPrompt({
      instructions: "Persistent instructions.",
      selectedMemory: "Selected memory.",
      bridgeGuidance: true,
      taskBrief: "Task.",
    });
    expect(Object.keys(composed.manifest).sort())
      .toEqual(["bridgeGuidance", "instructions", "persistentInstructions", "selectedMemory", "task"]);
  });

  it("the formation authority governs exactly these lanes", () => {
    expect([...FORMATION_GOVERNED_LANES]).toEqual(["instructions", "memory"]);
  });

  it("the Agent Studio wire protocol and form carry exactly these fields", () => {
    // The webview half. A toggle and a review region would need a message name and a form field.
    const reviewish = [...AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES]
      .filter((name) => /candidate|proposal|approve|reject|learn/i.test(name));
    expect(reviewish).toEqual([]);

    const form = canonicalWorkspaceStudioFormV1({
      name: "probe", cmd: "codex", kind: "agent", instructions: "", watch: "", steps: "", cwd: "",
      autostart: false, restartOnCrash: false, attention: false, worktree: false, branch: "",
      worktreeSetup: "", isolate: false, catchUp: false, schedTiming: "every", schedEvery: "",
      schedAt: "", schedTarget: "",
    });
    const booleans = Object.entries(form).filter(([, value]) => typeof value === "boolean").map(([key]) => key);
    expect(booleans.sort()).toEqual(["attention", "autostart", "catchUp", "isolate", "restartOnCrash", "worktree"]);
  });

  it("the forget cascade retires exactly these steps", () => {
    // The removal plan a human reads before deleting an agent. A stored ledger of agent-authored
    // state would owe this list a step, because anything durable has to be retired by name.
    expect([...AGENT_FORGET_PLAN_STEP_IDS]).toEqual([
      "stop-session",
      "remove-worktree",
      "retire-authority",
      "remove-locator",
      "quarantine-profile",
      "converge-runtime",
    ]);
  });

});

function profileWithReferenceKind(kind: string): unknown {
  return {
    schemaVersion: 1,
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    runtime: { adapter: "codex", executable: "codex" },
    references: [{
      id: "probe",
      kind,
      scope: "profile",
      owner: "123e4567-e89b-42d3-a456-426614174000",
      path: "probe.json",
      mode: "pinned",
      sha256: "a".repeat(64),
    }],
  };
}
