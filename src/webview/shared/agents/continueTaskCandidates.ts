/**
 * t-41117e — pure candidate rule for "Continue task in…".
 * No preact — unit tests and the picker UI share this filter.
 */
import { isAgentRow, isTemporaryAgentRow, type AgentVM } from "../../../sidebar/types";

/** Live enough that the destination cannot accept a new session yet. */
export function destinationBusy(a: AgentVM): boolean {
  return a.status === "running"
    || a.status === "needs"
    || a.status === "throttled"
    || a.status === "done"
    || a.status === "idle"
    || a.status === "stopping"
    || a.status === "stop-failed";
}

/**
 * Candidate rule (from fleet ContinuePicker, point of use):
 * exclude self, not terminal, not temporary; busy destinations stay listed but sorted after free ones.
 */
export function continueTaskCandidates(agents: readonly AgentVM[], fromName: string): AgentVM[] {
  return agents
    .filter((row) => row.name !== fromName)
    .filter((row) => isAgentRow(row))
    .filter((row) => !isTemporaryAgentRow(row))
    .slice()
    .sort((a, b) => Number(destinationBusy(a)) - Number(destinationBusy(b)));
}
