import type { ManagedEntryInfo } from "./AgentManager.js";
import { sealExecutionEvent, type RawExecutionEvent, type SealedExecutionEvent } from "../executionGraph/eventSchema.js";
import { mintTurn } from "../executionGraph/executionIdentity.js";

export interface ManagedAgentInputSource {
  manager: {
    list(): Promise<ManagedEntryInfo[]>;
    session(agent: string): string;
  };
  tmux: {
    sendKeys(session: string, text: string, submit: boolean): Promise<void>;
  };
  /**
   * SDD 480 Phase 2 — sink for execution-graph events. Optional: a source without it behaves exactly
   * as before, which is what keeps this wiring reversible.
   */
  recordExecution?: (event: SealedExecutionEvent) => void;
}

/** Seal and hand one event to the sink, never throwing: input must not fail because the graph did. */
function emit(source: ManagedAgentInputSource, raw: RawExecutionEvent): void {
  if (!source.recordExecution) return;
  try { source.recordExecution(sealExecutionEvent(raw)); } catch { /* observation only */ }
}

/**
 * Revalidates liveness at the operational authority immediately before touching the pane.
 *
 * Returns the minted `turnId` when the input was SUBMITTED, `undefined` when it was only typed.
 */
export async function sendManagedAgentInput(
  source: ManagedAgentInputSource,
  agent: string,
  text: string,
  submit: boolean,
  /** SDD 480 §7.1 — a runtime's own turn id, when it exposes one. Recorded as evidence, never authority. */
  nativeTurnId?: string,
): Promise<string | undefined> {
  const row = (await source.manager.list()).find((candidate) => candidate.name === agent);
  if (!row || row.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (!row.running || row.dead || row.stopping) throw new Error(`agent '${agent}' is not available for input`);

  // SDD 480 §7.1 — a turn begins when input is SUBMITTED, so that is where the id is minted. Text typed
  // without submitting has not started anything, and minting there would fill the graph with turns that
  // never ran. Minted BEFORE sendKeys for the reason every seam mints before it acts: the window
  // between starting and recording is where a fast thing escapes.
  const turn = submit ? mintTurn({ agentId: agent, ...(nativeTurnId ? { nativeTurnId } : {}) }) : undefined;
  if (turn) {
    emit(source, {
      kind: "spawn",
      node: "Turn",
      state: "running",
      // `measured`: Tachyon observed this submission itself — the one thing here we need no one's word for.
      provenance: "measured",
      correlation: { agentId: agent, executionId: turn.turnId, turnId: turn.turnId },
      at: new Date().toISOString(),
      detail: {
        seam: "agentInputService.sendManagedAgentInput",
        session: source.manager.session(agent),
        // The runtime's id rides along as evidence, under a name that cannot be mistaken for the
        // authority. Nothing downstream correlates on it.
        ...(turn.nativeAlias ? { nativeTurnAlias: turn.nativeAlias } : {}),
      },
      // The submitted TEXT is deliberately not recorded. The graph needs to know a turn began, not what
      // was said in it, and a prompt is the most likely place for a caller to have pasted a secret.
    });
  }
  await source.tmux.sendKeys(source.manager.session(agent), text, submit);
  return turn?.turnId;
}
