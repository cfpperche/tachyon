import type { ManagedEntryInfo } from "./AgentManager.js";

export interface ManagedAgentInputSource {
  manager: {
    list(): Promise<ManagedEntryInfo[]>;
    session(agent: string): string;
  };
  tmux: {
    sendKeys(session: string, text: string, submit: boolean): Promise<void>;
  };
}

/**
 * Revalidates liveness at the operational authority immediately before touching the pane.
 *
 */
export async function sendManagedAgentInput(
  source: ManagedAgentInputSource,
  agent: string,
  text: string,
  submit: boolean,
  _nativeTurnId?: string,
): Promise<string | undefined> {
  const row = (await source.manager.list()).find((candidate) => candidate.name === agent);
  if (!row || row.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (!row.running || row.dead || row.stopping) throw new Error(`agent '${agent}' is not available for input`);

  // SDD 480 §7.1 — a turn begins when input is SUBMITTED, so that is where the id is minted. Text typed
  // without submitting has not started anything, and minting there would fill the graph with turns that
  // never ran. Minted BEFORE sendKeys for the reason every seam mints before it acts: the window
  // between starting and recording is where a fast thing escapes.
  await source.tmux.sendKeys(source.manager.session(agent), text, submit);
  return undefined;
}
