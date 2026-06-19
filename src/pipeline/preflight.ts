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
  /** the node's command disables MCP entirely (claude `--safe-mode`), so NO injection can reach the Bridge */
  mcpDisabled?: boolean;
}

/**
 * - exit-based completion needs no Bridge → always `ok`.
 * - the node's command disables MCP (claude `--safe-mode`) → `cannot`: the injected Bridge can't load.
 * - any signal-based node needs the Bridge up; if it's down → `cannot`.
 * - codex AND claude (bridge up) → `ok`: Tachyon deterministically injects the `tachyon_bridge` MCP
 *   server at spawn for both (spec 236 — `-c` for codex, an additive `--mcp-config` for claude), so a
 *   Tachyon-spawned node always reaches `complete_node` (no project `.mcp.json` evidence needed).
 * - other/unknown runtime → `unprovable` (no injection path).
 */
export function nodeCanSignal(s: Signalability): SignalVerdict {
  if (EXIT_DONE.has(s.done)) return "ok";
  if (s.mcpDisabled) return "cannot";
  if (!s.bridgeUp) return "cannot";
  switch (s.runtime) {
    case "codex":
    case "claude":
      return "ok";
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
