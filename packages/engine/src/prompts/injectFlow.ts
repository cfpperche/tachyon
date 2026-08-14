/**
 * spec 381 — pure helpers for prompt-template inject (no vscode / no tmux).
 */

export interface InjectAgentCandidate {
  name: string;
  kind: "agent" | "terminal" | string;
  running: boolean;
  dead?: boolean;
  stopping?: boolean;
}

export interface InjectTarget {
  name: string;
  /** Short QuickPick description. */
  description: string;
}

/** Running AI agents only — the caller supplies the agent collection; stopped, dead, and stopping are excluded. */
export function injectTargets(agents: readonly InjectAgentCandidate[]): InjectTarget[] {
  return agents
    .filter((a) => a.running && !a.dead && !a.stopping)
    .map((a) => ({
      name: a.name,
      description: a.running ? "running AI agent" : "agent",
    }));
}

export type AttentionState = string | undefined;

export type SubmitRefuseReason = "working" | "throttled" | "composer-occupied";

/** A cached `working` label is busy only when the monitor has positive evidence of a real turn. */
export function isEvidencedWorking(state: AttentionState, hasStartedTurn: boolean | undefined): boolean {
  return state === "working" && hasStartedTurn === true;
}

/**
 * Whether submit (paste+Enter) is allowed. Matches write_input spirit:
 * refuse working/throttled and non-empty composer drafts.
 * Untracked attention (`undefined`) is treated as safe.
 */
export function submitRefuseReason(
  state: AttentionState,
  composerOccupied: boolean | undefined,
  hasStartedTurn: boolean | undefined,
): SubmitRefuseReason | undefined {
  if (isEvidencedWorking(state, hasStartedTurn)) return "working";
  if (state === "throttled") return "throttled";
  if (composerOccupied) return "composer-occupied";
  return undefined;
}

export const PREVIEW_CAP = 1400;

export function previewBody(body: string, cap = PREVIEW_CAP): string {
  if (body.length <= cap) return body;
  return `${body.slice(0, cap).trimEnd()}\n\n[preview truncated]`;
}
