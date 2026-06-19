import type { DoneKind } from "./loadPipeline.js";

/**
 * spec 232 — evidence-based pipeline-start preflight: can a node actually SIGNAL completion?
 *
 * The dogfood lesson: a signal-based node whose agent can't reach the Bridge `complete_node` tool hangs
 * silently to its timeout. This is the pure verdict the executor uses to fail closed (provably can't) or
 * warn (unprovable) BEFORE starting a doomed run — never an optimistic "it's fine" (codex M1).
 */

export type SignalVerdict = "ok" | "cannot" | "unprovable";
export type NodeRuntime = "claude" | "codex" | "other";

const EXIT_DONE: ReadonlySet<DoneKind> = new Set<DoneKind>(["exit", "exit_then_verify"]);

export interface Signalability {
  done: DoneKind;
  /** the runtime that will run this node (from the agent's cmd, or the inline cmd) */
  runtime: NodeRuntime;
  /** is the Tachyon Bridge currently listening? */
  bridgeUp: boolean;
  /** EVIDENCE for claude: a project `.mcp.json` registers the `tachyon` Bridge server */
  claudeMcpConfigured: boolean;
}

/**
 * - exit-based completion needs no Bridge → always `ok`.
 * - any signal-based node needs the Bridge up; if it's down → `cannot`.
 * - codex (bridge up) → `ok`: Tachyon injects the `tachyon_bridge` MCP server at spawn (spec 232).
 * - claude → `ok` only with positive evidence (`.mcp.json`); else `unprovable` (env-only might work, can't prove it).
 * - other/unknown runtime → `unprovable`.
 */
export function nodeCanSignal(s: Signalability): SignalVerdict {
  if (EXIT_DONE.has(s.done)) return "ok";
  if (!s.bridgeUp) return "cannot";
  switch (s.runtime) {
    case "codex":
      return "ok";
    case "claude":
      return s.claudeMcpConfigured ? "ok" : "unprovable";
    default:
      return "unprovable";
  }
}

/** Map a command's binary to the coarse runtime bucket the preflight reasons about. */
export function nodeRuntimeOf(binary: string): NodeRuntime {
  if (binary === "claude") return "claude";
  if (binary === "codex") return "codex";
  return "other";
}
