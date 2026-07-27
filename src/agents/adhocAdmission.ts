import type { ResumeRuntime } from "../resume/adapters.js";
import { parseLaunchCommand } from "../runtime/launchPreflight.js";

/**
 * SDD 478 M9 (`t-8f3f7d`) — the admission rule for the ad-hoc door.
 *
 * `spawn_agent` used to accept an arbitrary command and let `suggestKindForCommand` decide what came
 * out: a name in `KNOWN_AI_CLIS` produced an Agent, anything else produced a Terminal. That is the
 * inference rule 1 of the boundary forbids, and it left the tool unable to guarantee the entity it is
 * named for — the Bridge could hand a shell a task, a lineage, a brief and a worktree.
 *
 * The human ratified the replacement on 2026-07-27: the ad-hoc path stays an **Agent** operation and
 * admits only a supported LLM runtime, through a lighter path that needs no canonical profile. Generic
 * commands use an explicit Terminal operation instead, which carries no agent fields at all.
 *
 * ## Why this list exists instead of reusing one that already did
 *
 * Two neighbouring lists were both wrong for this door, in opposite directions.
 *
 * `ATTESTED_RUNTIMES` answers a *different* question: which runtime may back a **canonical profile**,
 * one Tachyon regenerates from an authored, host-signed authority. That bar is about owning a runtime's
 * native inputs, and it is deliberately narrow — using it here would have deleted OpenCode, Hermes,
 * Gemini and Qwen as agents outright, since `agents:` already admits only attested executables and the
 * ad-hoc path is their only door. That would orphan measured, shipped machinery (private XDG/HERMES
 * homes, resume, fork, activity normalizers, attention manifests, OpenCode's credential preflight) as a
 * side effect of a migration, which is exactly the kind of decision-by-negation this work was told not
 * to make.
 *
 * `KNOWN_AI_CLIS` is wrong in the other direction: it is an authoring *suggestion* catalog, and it
 * carries names (`aider`, `goose`, `amp`, `cursor-agent`, `copilot`, `verboo`, `agy`) that have no
 * adapter of any kind. A quick-add chip is not evidence that Tachyon can operate something.
 *
 * So membership here is declared per runtime, with the measured mechanism written down — and the gaps
 * written down too, because a runtime can be genuinely supported and still be missing something the
 * delegation contract wants. Recording that is what keeps a gap a filed task instead of a silent
 * deprecation.
 *
 * ## What membership means
 *
 * Every entry has a resume adapter in `src/resume/adapters.ts` — the deliberate, measured support that
 * makes an ad-hoc child survive restart and resume as the same entity, which is what makes it safe to
 * leave an assigned task with one. `antigravity` and `continue` have resume adapters but are absent
 * here on purpose: they are not AI CLIs to any authoring surface either, so the ad-hoc door never
 * produced an agent for them and this changes nothing for them.
 *
 * `test/unit/adhocAdmission.test.ts` re-derives the resume-adapter and brief-channel claims from the
 * same sources this file cites, so the declaration cannot drift from the code it describes.
 */

/** One runtime's measured ad-hoc Agent support. Prose is evidence: it names the mechanism, or the gap. */
export interface AdhocAgentRuntimeSupport {
  /** How a child reaches the Bridge, or null when it cannot — see `gap`. */
  bridge: string | null;
  /** How the delegation brief is delivered, or null when the runtime has no channel for one. */
  brief: string | null;
  /** True when this runtime may ALSO back a canonical profile (`ATTESTED_RUNTIMES`). */
  canonicalProfile: boolean;
  /** What makes this a runtime Tachyon operates rather than a process it starts. */
  evidence: string;
  /** A declared shortfall against the delegation contract, and the task that owns closing it. */
  gap?: string;
}

/**
 * The runtimes the ad-hoc door may operate as an Agent.
 *
 * Keyed by the resolved executable name, which is also the resume-runtime name. Adding one means
 * stating its mechanisms; a runtime absent here is refused with a reason naming the Terminal operation.
 */
const DECLARED = {
  claude: {
    bridge: "--mcp-config with a materialized Bridge server file",
    brief: "startup argument",
    canonicalProfile: true,
    evidence: "resume adapter with minted session ids, private CLAUDE_CONFIG_DIR harness, fork, activity normalizer, attention manifest",
  },
  codex: {
    bridge: "-c mcp_servers.tachyon_bridge config override",
    brief: "startup argument",
    canonicalProfile: true,
    evidence: "resume adapter (captured ids), private CODEX_HOME harness, activity normalizer, attention manifest",
  },
  grok: {
    bridge: "private GROK_HOME carrying the Bridge MCP",
    brief: "startup argument",
    canonicalProfile: true,
    evidence: "resume adapter with minted ids and a measured transcript path, GROK_HOME harness, fork, activity normalizer, attention manifest",
  },
  pi: {
    bridge: "staged Pi Bridge extension in a private session dir",
    brief: "startup argument",
    canonicalProfile: true,
    evidence: "resume adapter with minted ids and native fork, private session dirs, activity normalizer, attention manifest",
  },
  opencode: {
    bridge: "OPENCODE_CONFIG pointing at a materialized Bridge MCP config",
    brief: "TUI prefill (--prompt)",
    canonicalProfile: false,
    evidence: "resume adapter with native fork, private XDG config/data/state harness with seeded auth, activity normalizer, attention manifest, measured credential preflight (t-0338fc)",
  },
  hermes: {
    bridge: "private HERMES_HOME carrying the Bridge MCP",
    brief: "HERMES_TUI_QUERY environment channel",
    canonicalProfile: false,
    evidence: "resume adapter over its state.db, private HERMES_HOME harness, activity normalizer with an observed-model reader",
  },
  gemini: {
    bridge: null,
    brief: "startup argument (-i)",
    canonicalProfile: false,
    evidence: "resume adapter with minted session ids (--session-id / --resume)",
    gap: "no Bridge wiring, so a delegated child cannot call notify_agent or the task tools — the contract reaches it but its answer cannot come back (t-59f67c)",
  },
  qwen: {
    bridge: null,
    brief: null,
    canonicalProfile: false,
    evidence: "resume adapter scoped to the cwd (--continue / --resume), measured around QwenLM/qwen-code#2603",
    gap: "no Bridge wiring and no opening-brief channel, so a delegated child receives neither the contract nor a way to report on it (t-59f67c)",
  },
} as const satisfies Partial<Record<ResumeRuntime, AdhocAgentRuntimeSupport>>;

/**
 * The keys come from the literal above — so a name here is a real `ResumeRuntime`, checked by the
 * compiler — while the VALUE type is widened to the interface, so a reader can ask any entry for its
 * `gap` instead of the answer depending on which entry happens to declare one.
 */
export type SupportedAdhocAgentRuntime = keyof typeof DECLARED;

export const SUPPORTED_ADHOC_AGENT_RUNTIMES: Readonly<Record<SupportedAdhocAgentRuntime, AdhocAgentRuntimeSupport>> = DECLARED;

/** The refusal is contract: it must name the operation to use instead, not merely say no. */
export const TERMINAL_OPERATION = "spawn_terminal";

export type AdhocAdmission =
  | { ok: true; runtime: SupportedAdhocAgentRuntime }
  | { ok: false; reason: string };

/**
 * Thrown when a door asks the manager for an ad-hoc Agent it may not create.
 *
 * Typed rather than a bare `Error` so a caller can tell "this may not be an Agent" from every other
 * spawn failure — the difference decides whether the answer is "fix the command" or "use the other
 * operation", and only the second is actionable without changing what you meant to run.
 */
export class AdhocAgentAdmissionError extends Error {
  readonly code = "adhoc_agent_runtime_unsupported";

  constructor(reason: string) {
    super(reason);
    this.name = "AdhocAgentAdmissionError";
  }
}

export function isSupportedAdhocAgentRuntime(value: string | null | undefined): value is SupportedAdhocAgentRuntime {
  return typeof value === "string" && Object.hasOwn(SUPPORTED_ADHOC_AGENT_RUNTIMES, value);
}

/** The supported names, in declaration order, for diagnostics and tool descriptions. */
export const SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES = Object.keys(SUPPORTED_ADHOC_AGENT_RUNTIMES) as SupportedAdhocAgentRuntime[];

function supportedList(): string {
  return SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES.join(", ");
}

/**
 * Decide whether an ad-hoc `cmd` may become an Agent.
 *
 * Returns the runtime it resolved to, or a refusal whose text names `spawn_terminal` — the entire cost
 * of the `t-9418ac` incident was three increments spent discovering *which* door an entry belonged in,
 * so a refusal that does not name the other door repeats it.
 */
export function admitAdhocAgentCommand(cmd: string): AdhocAdmission {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return { ok: false, reason: `an ad-hoc agent needs a command naming a supported LLM runtime (${supportedList()})` };
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
  if (isSupportedAdhocAgentRuntime(binary)) return { ok: true, runtime: binary };

  return {
    ok: false,
    reason:
      `'${binary}' is not a supported LLM runtime, so it cannot be spawned as an agent — Tachyon has no measured`
      + ` resume, brief or Bridge path for it, and an agent it cannot operate is a process with a task it can never`
      + ` report on. Supported: ${supportedList()}. Use ${TERMINAL_OPERATION} for a generic process — a shell, a`
      + ` server, a build — which carries no agent fields.`,
  };
}
