import type { ResumeRuntime } from "../resume/adapters.js";
import { runtimeOf } from "../resume/adapters.js";
import { parseLaunchCommand } from "../runtime/launchPreflight.js";
import { runtimePromptAdapter } from "./runtimePromptAdapters.js";

/**
 * Authoring-catalog basenames with no resume/brief/Bridge machinery. Kept as a closed set so this
 * module does not import `loadConfig` (node:fs) — that import dragged Node into browser bundles.
 * `test/unit/agentRuntimeAdmission.test.ts` pins this set against `KNOWN_AI_CLIS` minus supported
 * and minus anything with a resume or brief channel, so a catalog change cannot drift unnoticed.
 */
export const AUTHORING_CATALOG_WITHOUT_ADAPTERS: ReadonlySet<string> = new Set([
  "aider",
  "goose",
  "amp",
  "cursor-agent",
  "copilot",
  "verboo",
]);

/**
 * t-7ff13d (Agent Instance cut, etapa 4) — ONE admission path for Agent Instance, keyed on runtime
 * capability.
 *
 * Replaces `adhocAdmission` / `SUPPORTED_ADHOC_*`, which named a Temporary-only door and read as a
 * second species. Saved and Temporary both need the same answer: "can Tachyon operate this
 * executable as an Agent?" Identity/lifetime are declared elsewhere; this module never infers them
 * from origin (config vs session vs cmd).
 *
 * ## History (SDD 478 M9 / `t-8f3f7d`)
 *
 * `spawn_agent` used to accept an arbitrary command and let `suggestKindForCommand` decide what came
 * out: a name in `KNOWN_AI_CLIS` produced an Agent, anything else produced a Terminal. That inference
 * is forbidden. The human ratified: the Agent path admits only a supported LLM runtime; generic
 * commands use `spawn_terminal`, which carries no agent fields.
 *
 * ## Why this list exists instead of reusing one that already did
 *
 * `ATTESTED_RUNTIMES` answers a *different* question: which runtime may back a **Saved Profile**
 * (host-signed authority). Using it here would delete OpenCode, Hermes, Gemini and Qwen as agents
 * for Temporary delegation — measured machinery with no profile door. That is not this cut.
 *
 * `KNOWN_AI_CLIS` is wrong the other way: authoring suggestions (`aider`, `goose`, …) with no
 * adapter. A chip is not evidence Tachyon can operate something.
 *
 * Membership is declared per runtime with measured mechanisms — and gaps — so a shortfall stays a
 * filed task, not a silent deprecation. Do not widen the set without new measured evidence.
 *
 * ## What membership means
 *
 * Every entry has a resume adapter in `packages/shared/src/resume/adapters.ts` — measured support that lets an
 * instance survive restart/resume as the same entity. `antigravity` and `continue` have resume
 * adapters (and Antigravity also a brief channel) but stay absent by admission decision: the Agent
 * door does not operate them; they run as Terminals via `spawn_terminal`. A refusal for those
 * binaries must diagnose the measured gaps, not claim all three mechanisms are absent (`t-5d8e96`).
 *
 * `test/unit/agentRuntimeAdmission.test.ts` re-derives resume-adapter and brief-channel claims from
 * the same sources this file cites, so the declaration cannot drift from the code it describes.
 */

/** One runtime's measured Agent Instance support. Prose is evidence: it names the mechanism, or the gap. */
export interface AgentRuntimeSupport {
  /** How an instance reaches the Bridge, or null when it cannot — see `gap`. */
  bridge: string | null;
  /** How a delegation brief is delivered, or null when the runtime has no channel for one. */
  brief: string | null;
  /** True when this runtime may ALSO back a Saved Profile (`ATTESTED_RUNTIMES`). */
  savedAgentProfile: boolean;
  /** What makes this a runtime Tachyon operates rather than a process it starts. */
  evidence: string;
  /** A declared shortfall against the delegation contract, and the task that owns closing it. */
  gap?: string;
}

/**
 * The runtimes Tachyon may operate as an Agent Instance.
 *
 * Keyed by the resolved executable name (also the resume-runtime name). Adding one means stating
 * its mechanisms; a runtime absent here is refused with a reason naming the Terminal operation.
 */
const DECLARED = {
  claude: {
    bridge: "--mcp-config with a materialized Bridge server file",
    brief: "startup argument",
    savedAgentProfile: true,
    evidence: "resume adapter with minted session ids, private CLAUDE_CONFIG_DIR harness, fork, activity normalizer, attention manifest",
  },
  codex: {
    bridge: "-c mcp_servers.tachyon_bridge config override",
    brief: "startup argument",
    savedAgentProfile: true,
    evidence: "resume adapter (captured ids), private CODEX_HOME harness, activity normalizer, attention manifest",
  },
  grok: {
    bridge: "private GROK_HOME carrying the Bridge MCP",
    brief: "startup argument",
    savedAgentProfile: true,
    evidence: "resume adapter with minted ids and a measured transcript path, GROK_HOME harness, fork, activity normalizer, attention manifest",
  },
  pi: {
    bridge: "staged Pi Bridge extension in a private session dir",
    brief: "startup argument",
    savedAgentProfile: true,
    evidence: "resume adapter with minted ids and native fork, private session dirs, activity normalizer, attention manifest",
  },
  opencode: {
    bridge: "OPENCODE_CONFIG pointing at a materialized Bridge MCP config",
    brief: "TUI prefill (--prompt)",
    savedAgentProfile: false,
    evidence: "resume adapter with native fork, private XDG config/data/state harness with seeded auth, activity normalizer, attention manifest, measured credential preflight (t-0338fc)",
  },
  hermes: {
    bridge: "private HERMES_HOME carrying the Bridge MCP",
    brief: "HERMES_TUI_QUERY environment channel",
    savedAgentProfile: false,
    evidence: "resume adapter over its state.db, private HERMES_HOME harness, activity normalizer with an observed-model reader",
  },
  gemini: {
    bridge: null,
    brief: "startup argument (-i)",
    savedAgentProfile: false,
    evidence: "resume adapter with minted session ids (--session-id / --resume)",
    gap: "no Bridge wiring, so a delegated child cannot call notify_agent or the task tools — the contract reaches it but its answer cannot come back (t-59f67c)",
  },
  qwen: {
    bridge: null,
    brief: null,
    savedAgentProfile: false,
    evidence: "resume adapter scoped to the cwd (--continue / --resume), measured around QwenLM/qwen-code#2603",
    gap: "no Bridge wiring and no opening-brief channel, so a delegated child receives neither the contract nor a way to report on it (t-59f67c)",
  },
} as const satisfies Partial<Record<ResumeRuntime, AgentRuntimeSupport>>;

/**
 * The keys come from the literal above — so a name here is a real `ResumeRuntime`, checked by the
 * compiler — while the VALUE type is widened to the interface, so a reader can ask any entry for its
 * `gap` instead of the answer depending on which entry happens to declare one.
 */
export type SupportedAgentRuntime = keyof typeof DECLARED;

export const SUPPORTED_AGENT_RUNTIMES: Readonly<Record<SupportedAgentRuntime, AgentRuntimeSupport>> = DECLARED;

/** The refusal is contract: it must name the operation to use instead, not merely say no. */
export const TERMINAL_OPERATION = "spawn_terminal";

export type AgentRuntimeAdmission =
  | { ok: true; runtime: SupportedAgentRuntime }
  | { ok: false; reason: string };

/**
 * Thrown when a door asks the manager for an Agent Instance it may not create.
 *
 * Typed rather than a bare `Error` so a caller can tell "this may not be an Agent" from every other
 * spawn failure — the difference decides whether the answer is "fix the command" or "use the other
 * operation", and only the second is actionable without changing what you meant to run.
 */
export class AgentRuntimeAdmissionError extends Error {
  readonly code = "agent_runtime_unsupported";

  constructor(reason: string) {
    super(reason);
    this.name = "AgentRuntimeAdmissionError";
  }
}

export function isSupportedAgentRuntime(value: string | null | undefined): value is SupportedAgentRuntime {
  return typeof value === "string" && Object.hasOwn(SUPPORTED_AGENT_RUNTIMES, value);
}

/** The supported names, in declaration order, for diagnostics and tool descriptions. */
export const SUPPORTED_AGENT_RUNTIME_NAMES = Object.keys(SUPPORTED_AGENT_RUNTIMES) as SupportedAgentRuntime[];

function supportedList(): string {
  return SUPPORTED_AGENT_RUNTIME_NAMES.join(", ");
}

/** Shared exit every refusal ends on — forbidding without a door is the expensive form of this family. */
function useTerminalExit(): string {
  return (
    `Supported: ${supportedList()}. Use ${TERMINAL_OPERATION} for a generic process — a shell, a`
    + ` server, a build — which carries no agent fields.`
  );
}

/**
 * t-5d8e96 — diagnose the measured seams for a binary the Agent door refuses.
 *
 * Derived from the same sources the parity matrix cites (`runtimeOf` / resume adapters, prompt
 * adapters for brief). Never claim absence of a seam that exists. Bridge is absent for every
 * non-admitted binary today (only the supported full set wires it); that is stated only when it is
 * the honest shortfall, not as a universal composite.
 *
 * Buckets:
 * 1. Secondary with partial machinery (resume and/or brief) — Terminal by admission, not total void
 * 2. Authoring-catalog chip with no adapters — quick-add is not operation evidence
 * 3. Generic process — not an LLM runtime Tachyon operates
 */
function refuseUnsupportedBinary(binary: string): string {
  const hasResume = runtimeOf(binary) !== null;
  // Brief = a compose channel the opening-prompt seam can actually deliver (matches instructionsDeliverable).
  const hasBrief = runtimePromptAdapter(binary)?.compose !== undefined;
  // Non-admitted binaries never reach withRuntimeBridge family branches; Bridge is absent for all of them.
  const hasBridge = false;

  if (hasResume || hasBrief) {
    const measured: string[] = [];
    if (hasResume) measured.push("resume");
    if (hasBrief) measured.push("brief");
    const measuredText =
      measured.length === 1
        ? measured[0]
        : `${measured[0]} and ${measured[1]}`;

    // Resume is never the sole missing piece here: if we lack resume and brief we fall through to
    // other buckets. Partial secondaries always lack Bridge today; brief may or may not be present.
    const missingParts: string[] = [];
    if (!hasBrief) missingParts.push("no brief channel");
    if (!hasBridge) missingParts.push("no Bridge path");
    const missingText = missingParts.join(" and ");

    // Consequence is specific: no Bridge ⇒ cannot answer; no brief + no Bridge ⇒ neither direction.
    const consequence =
      !hasBrief && !hasBridge
        ? "so a delegated child would receive neither a full opening contract nor a way to report on it"
        : "so a delegated child could not call notify_agent or the task tools";

    return (
      `'${binary}' is not an admitted Agent runtime — Tachyon measures ${measuredText} for it, but has`
      + ` ${missingText}, ${consequence}. The Agent door does not operate it.`
      + ` ${useTerminalExit()}`
    );
  }

  if (AUTHORING_CATALOG_WITHOUT_ADAPTERS.has(binary)) {
    return (
      `'${binary}' is an authoring-catalog CLI with no measured resume, brief or Bridge path — a`
      + ` quick-add chip is not evidence Tachyon can operate it as an agent.`
      + ` ${useTerminalExit()}`
    );
  }

  return (
    `'${binary}' is not a supported LLM runtime — Tachyon has no measured resume, brief or Bridge path`
    + ` for it, and an agent it cannot operate is a process with a task it can never report on.`
    + ` ${useTerminalExit()}`
  );
}

/**
 * Decide whether a command may become an Agent Instance.
 *
 * Returns the runtime it resolved to, or a refusal whose text names `spawn_terminal` — the entire cost
 * of the `t-9418ac` incident was three increments spent discovering *which* door an entry belonged in,
 * so a refusal that does not name the other door repeats it.
 *
 * Does not decide Saved vs Temporary — callers declare lifetime/identity separately.
 */
export function admitAgentRuntimeCommand(cmd: string): AgentRuntimeAdmission {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return { ok: false, reason: `an agent needs a command naming a supported LLM runtime (${supportedList()})` };
  }

  const parsed = parseLaunchCommand(trimmed);
  if (!parsed) {
    // Ambiguity is refused, not resolved. A Terminal runs a command verbatim and does not care what is
    // in it; an Agent's identity depends on which runtime actually starts, so the door that grants
    // agent semantics has to be able to name it.
    return {
      ok: false,
      reason:
        `'${trimmed}' does not resolve to a single executable, so Tachyon cannot name the runtime that would operate this agent`
        + ` — shell composition and substitution are not resolved here. Use ${TERMINAL_OPERATION}, which runs the command verbatim,`
        + ` or pass a supported runtime directly (${supportedList()}).`,
    };
  }

  const binary = parsed.binary.split(/[\\/]/).pop() ?? parsed.binary;
  if (isSupportedAgentRuntime(binary)) return { ok: true, runtime: binary };

  return { ok: false, reason: refuseUnsupportedBinary(binary) };
}
