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

/** Revalidates liveness at the operational authority immediately before touching the pane. */
export async function sendManagedAgentInput(
  source: ManagedAgentInputSource,
  agent: string,
  text: string,
  submit: boolean,
): Promise<void> {
  const row = (await source.manager.list()).find((candidate) => candidate.name === agent);
  if (!row || row.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (!row.running || row.dead || row.stopping) throw new Error(`agent '${agent}' is not available for input`);
  await source.tmux.sendKeys(source.manager.session(agent), text, submit);
}
