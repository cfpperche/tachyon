import { describe, expect, it } from "vitest";
import {
  admitAgentRuntimeCommand,
  AgentRuntimeAdmissionError,
  isSupportedAgentRuntime,
  SUPPORTED_AGENT_RUNTIMES,
  SUPPORTED_AGENT_RUNTIME_NAMES,
  TERMINAL_OPERATION,
} from "../../src/agents/agentRuntimeAdmission.js";
import { ATTESTED_RUNTIMES, isAttestedRuntime } from "../../src/runtime/attestedRuntimes.js";
import { RESUME_RUNTIMES } from "../../src/resume/adapters.js";
import { instructionsDeliverable, KNOWN_AI_CLIS } from "../../src/config/loadConfig.js";

/**
 * SDD 478 M9 (`t-8f3f7d`) — Agent Instance admission stops inferring what it creates.
 * Agent Instance cut etapa 4 (`t-7ff13d`) — one runtime-capability door (not Temporary-only
 * `adhocAdmission` / `SUPPORTED_ADHOC_*`).
 *
 * Before M9, `spawn_agent` took any command and `suggestKindForCommand` decided the outcome: a name
 * in the authoring catalog became an Agent, everything else became a Terminal. So the Bridge could
 * hand a shell a task, a lineage, a brief and a worktree, and the tool named for agents could not
 * guarantee it had produced one.
 */

describe("t-7ff13d — single runtime admission door", () => {
  it("throws AgentRuntimeAdmissionError with agent_runtime_unsupported (not the Temporary-only code)", () => {
    const err = new AgentRuntimeAdmissionError("not a supported LLM runtime — use spawn_terminal");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentRuntimeAdmissionError");
    expect(err.code).toBe("agent_runtime_unsupported");
    expect(err.message).toContain(TERMINAL_OPERATION);
  });

  it("exports no Temporary-only species names", () => {
    // Fail-before for the cut: importers must bind the runtime-capability symbols.
    expect(SUPPORTED_AGENT_RUNTIME_NAMES).toEqual([
      "claude", "codex", "grok", "pi", "opencode", "hermes", "gemini", "qwen",
    ]);
    expect(isSupportedAgentRuntime("claude")).toBe(true);
    expect(isSupportedAgentRuntime("sh")).toBe(false);
  });
});

describe("t-8f3f7d — what the runtime door admits", () => {
  it.each(SUPPORTED_AGENT_RUNTIME_NAMES)("admits %s, the plain form", (runtime) => {
    expect(admitAgentRuntimeCommand(runtime)).toEqual({ ok: true, runtime });
  });

  it.each([
    ["a flag-carrying command", "claude --model sonnet", "claude"],
    ["an absolute path", "/usr/local/bin/codex", "codex"],
    ["a package launcher", "npx opencode --agent build", "opencode"],
    ["an env wrapper", "env XDG_DATA_HOME=/private/data opencode", "opencode"],
    ["a launcher plus an env wrapper", "env FOO=1 npx grok -m grok-4.5", "grok"],
    ["a quoted argument", 'pi --prompt "do the thing"', "pi"],
  ])("resolves the executable through %s", (_label, cmd, runtime) => {
    expect(admitAgentRuntimeCommand(cmd)).toEqual({ ok: true, runtime });
  });
});

describe("t-8f3f7d — what the runtime door refuses, and what the refusal says", () => {
  it.each([
    ["a bare shell", "sh"],
    ["a shell one-liner", "sh -c true"],
    ["an echoer", "echo hi"],
    ["a server", "npm run dev"],
    ["a sleeper", "sleep 1"],
    ["a build", "make -j4"],
  ])("refuses %s and names the operation that WILL run it", (_label, cmd) => {
    const admission = admitAgentRuntimeCommand(cmd);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    // The refusal text is contract, not decoration: the entire cost of the t-9418ac incident was three
    // increments spent discovering WHICH door the entry belonged in.
    expect(admission.reason).toContain(TERMINAL_OPERATION);
    expect(admission.reason).toContain("not a supported LLM runtime");
  });

  it.each([
    ["shell composition", "claude && rm -rf /"],
    ["a pipeline", "claude | tee log"],
    ["command substitution", "$(which claude)"],
    ["a subshell", "(claude)"],
  ])("refuses %s rather than resolving it", (_label, cmd) => {
    // A Terminal runs a command verbatim and does not care what is in it. An Agent's identity depends
    // on which runtime actually starts, so the door that grants agent semantics must be able to name it.
    const admission = admitAgentRuntimeCommand(cmd);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.reason).toContain("does not resolve to a single executable");
    expect(admission.reason).toContain(TERMINAL_OPERATION);
  });

  it("refuses an empty command without pretending to have resolved one", () => {
    expect(admitAgentRuntimeCommand("   ")).toEqual({
      ok: false,
      reason: expect.stringContaining("needs a command naming a supported LLM runtime"),
    });
  });

  it("refuses the authoring catalog's unbacked names — a quick-add chip is not evidence", () => {
    // `KNOWN_AI_CLIS` exists to pre-select a kind for a human who can override it. These names have no
    // adapter of any kind, so admitting them would be the old inference wearing a new list.
    const catalogOnly = KNOWN_AI_CLIS.filter((cli) => !isSupportedAgentRuntime(cli));
    expect(catalogOnly.length).toBeGreaterThan(0);
    for (const cli of catalogOnly) {
      expect(admitAgentRuntimeCommand(cli).ok).toBe(false);
    }
  });
});

describe("t-8f3f7d — the declaration is evidence, and cannot drift from it", () => {
  it("every supported runtime has the resume adapter the declaration claims", () => {
    // Resume is the deliberate, measured support that makes an ad-hoc child survive as the same entity
    // — which is what makes it safe to leave an assigned task with one.
    for (const runtime of SUPPORTED_AGENT_RUNTIME_NAMES) {
      expect(RESUME_RUNTIMES).toContain(runtime);
    }
  });

  it("the declared brief channel agrees with the code that delivers one", () => {
    for (const [runtime, support] of Object.entries(SUPPORTED_AGENT_RUNTIMES)) {
      expect(instructionsDeliverable(runtime)).toBe(support.brief !== null);
    }
  });

  it("a runtime that cannot reach the Bridge declares the gap rather than hiding it", () => {
    // Preserved on purpose (the product supports them), but a delegated child that cannot call
    // notify_agent is a task handed into silence — so the shortfall is written down and owned.
    for (const [runtime, support] of Object.entries(SUPPORTED_AGENT_RUNTIMES)) {
      if (support.bridge === null) {
        expect(support.gap, `${runtime} has no Bridge and must declare why that is tolerated`).toBeTruthy();
        expect(support.gap).toMatch(/t-[0-9a-f]{6}/);
      } else {
        expect(support.gap).toBeUndefined();
      }
    }
  });

  it("stays a SEPARATE list from canonical attestation, in both directions", () => {
    // ATTESTED_RUNTIMES answers "may this back a canonical profile". Every attested runtime can also be
    // driven as Temporary Agent Instance, but the reverse is deliberately false — collapsing the two
    // would have deleted OpenCode, Hermes, Gemini and Qwen as agents as a side effect of a migration.
    for (const attested of ATTESTED_RUNTIMES) expect(isSupportedAgentRuntime(attested)).toBe(true);
    const temporaryOnly = SUPPORTED_AGENT_RUNTIME_NAMES.filter((runtime) => !isAttestedRuntime(runtime));
    expect(temporaryOnly).toEqual(["opencode", "hermes", "gemini", "qwen"]);
    for (const runtime of SUPPORTED_AGENT_RUNTIME_NAMES) {
      expect(SUPPORTED_AGENT_RUNTIMES[runtime].canonicalProfile).toBe(isAttestedRuntime(runtime));
    }
  });

  it("declares nothing it cannot resume — antigravity and continue are absent on purpose", () => {
    // They have resume adapters but are not AI CLIs to any authoring surface either, so the ad-hoc door
    // never produced an agent for them: excluding them removes no capability.
    for (const runtime of ["antigravity", "continue"]) {
      expect(RESUME_RUNTIMES).toContain(runtime);
      expect(KNOWN_AI_CLIS).not.toContain(runtime);
      expect(isSupportedAgentRuntime(runtime)).toBe(false);
    }
  });
});
