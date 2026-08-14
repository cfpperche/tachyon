import { describe, expect, it } from "vitest";
import {
  admitAgentRuntimeCommand,
  AgentRuntimeAdmissionError,
  AUTHORING_CATALOG_WITHOUT_ADAPTERS,
  isSupportedAgentRuntime,
  SUPPORTED_AGENT_RUNTIMES,
  SUPPORTED_AGENT_RUNTIME_NAMES,
  TERMINAL_OPERATION,
} from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import { ATTESTED_RUNTIMES, isAttestedRuntime } from "@tachyon/shared/runtime/attestedRuntimes.js";
import { RESUME_RUNTIMES, runtimeOf } from "@tachyon/shared/resume/adapters.js";
import { instructionsDeliverable, KNOWN_AI_CLIS } from "@tachyon/engine/config/loadConfig.js";
import { runtimePromptAdapter } from "@tachyon/shared/agents/runtimePromptAdapters.js";

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

/**
 * t-5d8e96 — a refusal that claims "no measured resume, brief or Bridge" for every non-admitted
 * binary is factually false: Antigravity and Continue have measured partial machinery, and the
 * parity matrix classifies them as Terminal by admission decision, not by total absence. The
 * phrase must diagnose what THAT binary lacks (or that the Agent door does not operate it), and
 * still name spawn_terminal. Verdict is the phrase, not admission.
 */
describe("t-5d8e96 — refusal diagnosis is true per runtime", () => {
  function refuse(cmd: string): string {
    const admission = admitAgentRuntimeCommand(cmd);
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("expected refusal");
    expect(admission.reason).toContain(TERMINAL_OPERATION);
    return admission.reason;
  }

  it("Antigravity (agy): names measured resume+brief and the missing Bridge / non-admission, not total absence", () => {
    // Matrix §3.3 / §3.6.1: resume ✓, brief ✓ (--prompt-interactive), Bridge —, Agent door ✗ Terminal.
    const reason = refuse("agy");
    expect(reason).toMatch(/resume/i);
    expect(reason).toMatch(/brief/i);
    expect(reason).toMatch(/Bridge/i);
    // Must not recycle the composite lie that none of the three exist.
    expect(reason).not.toMatch(/no measured\s+resume,\s*brief or Bridge/i);
    // Honest about presence, not inventing Bridge.
    expect(reason).toMatch(/measures?\s+resume and brief/i);
    expect(reason).toMatch(/no Bridge/i);
    expect(reason).toMatch(/not an admitted Agent runtime|Agent door does not operate/i);
  });

  it("Continue: names measured resume and the missing brief+Bridge, not total absence", () => {
    // Matrix §3.3 / §3.6.1: resume ✓, brief —, Bridge —, Agent door ✗ Terminal.
    const reason = refuse("continue");
    expect(reason).toMatch(/resume/i);
    expect(reason).toMatch(/brief/i);
    expect(reason).toMatch(/Bridge/i);
    expect(reason).not.toMatch(/no measured\s+resume,\s*brief or Bridge/i);
    expect(reason).toMatch(/measures?\s+resume/i);
    expect(reason).toMatch(/no brief/i);
    expect(reason).toMatch(/no Bridge|Bridge path/i);
    expect(reason).toMatch(/not an admitted Agent runtime|Agent door does not operate/i);
  });

  it("authoring-only CLI (aider): names catalog chip with no adapters of any kind", () => {
    const reason = refuse("aider");
    expect(reason).toMatch(/authoring-catalog|quick-add chip/i);
    expect(reason).toMatch(/no measured resume, brief or Bridge/i);
    expect(reason).not.toMatch(/measures?\s+resume/i);
  });

  it("generic command (sh): names non-runtime process without claiming a secondary-runtime partial path", () => {
    const reason = refuse("sh");
    expect(reason).toMatch(/not a supported LLM runtime/i);
    expect(reason).toMatch(/no measured resume, brief or Bridge/i);
    expect(reason).not.toMatch(/authoring-catalog|quick-add chip/i);
    expect(reason).not.toMatch(/measures?\s+resume/i);
  });

  it("cn (Continue alias) gets the same honest Continue diagnosis as the canonical binary", () => {
    const viaCn = refuse("cn");
    const viaContinue = refuse("continue");
    // Alias must not fall into the generic "no measured resume…" bucket.
    expect(viaCn).toMatch(/measures?\s+resume/i);
    expect(viaCn).not.toMatch(/no measured\s+resume,\s*brief or Bridge/i);
    // Same shape of diagnosis (both name the missing seams).
    expect(viaCn).toMatch(/brief/i);
    expect(viaContinue).toMatch(/brief/i);
  });

  it("still refuses every non-admitted binary — phrase change is not admission change", () => {
    for (const cmd of ["agy", "continue", "cn", "aider", "goose", "sh", "npm run dev", "echo hi"]) {
      expect(admitAgentRuntimeCommand(cmd).ok).toBe(false);
    }
    for (const runtime of SUPPORTED_AGENT_RUNTIME_NAMES) {
      expect(admitAgentRuntimeCommand(runtime).ok).toBe(true);
    }
  });

  it("AUTHORING_CATALOG_WITHOUT_ADAPTERS tracks catalog chips that have no resume or brief channel", () => {
    // Closed set in the admission module (avoids importing loadConfig into browser bundles). Must equal
    // every KNOWN_AI_CLIS name that is neither supported nor partially measured.
    const fromCatalog = KNOWN_AI_CLIS.filter((cli) => {
      if (isSupportedAgentRuntime(cli)) return false;
      if (runtimeOf(cli) !== null) return false;
      if (runtimePromptAdapter(cli)?.compose !== undefined) return false;
      return true;
    }).sort();
    expect([...AUTHORING_CATALOG_WITHOUT_ADAPTERS].sort()).toEqual(fromCatalog);
  });
});

describe("t-8f3f7d — the declaration is evidence, and cannot drift from it", () => {
  it("every supported runtime has the resume adapter the declaration claims", () => {
    // Resume is the deliberate, measured support that makes a Temporary child survive as the same entity
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
      expect(SUPPORTED_AGENT_RUNTIMES[runtime].savedAgentProfile).toBe(isAttestedRuntime(runtime));
    }
  });

  it("declares nothing it cannot resume — antigravity and continue are absent on purpose", () => {
    // Resume adapters exist; the Agent door still refuses them (Terminal by admission). The runtime
    // names are not catalog chips (`agy` is the Antigravity binary and is catalogued; `continue`/`cn`
    // are not). t-5d8e96 covers the honest refusal text separately.
    for (const runtime of ["antigravity", "continue"] as const) {
      expect(RESUME_RUNTIMES).toContain(runtime);
      expect(KNOWN_AI_CLIS).not.toContain(runtime);
      expect(isSupportedAgentRuntime(runtime)).toBe(false);
    }
    expect(KNOWN_AI_CLIS).toContain("agy");
    expect(isSupportedAgentRuntime("agy")).toBe(false);
  });
});
