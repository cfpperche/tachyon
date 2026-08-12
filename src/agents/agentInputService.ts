import type { ManagedEntryInfo } from "./AgentManager.js";
import { composerProfileFor } from "../runtime/composerRegion.js";
import type { SubmitReceipt } from "../tmux/TmuxService.js";

export type ManagedAgentInputReceipt = SubmitReceipt | { status: "typed-unsubmitted" };

export interface ManagedAgentInputSource {
  manager: {
    list(): Promise<ManagedEntryInfo[]>;
    session(agent: string): string;
    defOf?(agent: string): { cmd?: string } | undefined;
  };
  tmux: {
    sendKeys(session: string, text: string, submit: boolean): Promise<void>;
    sendSubmittedLine(session: string, text: string, options: { composer?: ReturnType<typeof composerProfileFor> }): Promise<SubmitReceipt>;
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
): Promise<ManagedAgentInputReceipt> {
  const row = (await source.manager.list()).find((candidate) => candidate.name === agent);
  if (!row || row.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (!row.running || row.dead || row.stopping) throw new Error(`agent '${agent}' is not available for input`);

  const session = source.manager.session(agent);
  if (!submit) {
    await source.tmux.sendKeys(session, text, false);
    return { status: "typed-unsubmitted" };
  }
  return source.tmux.sendSubmittedLine(session, text, {
    composer: composerProfileFor(source.manager.defOf?.(agent)?.cmd),
  });
}
