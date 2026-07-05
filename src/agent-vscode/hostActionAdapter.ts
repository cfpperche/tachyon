import type { HostActionPort } from "../host-action/port.js";
import { HostActionError, type HostActionExecutionEnvelope, type HostActionPortResult } from "../host-action/types.js";
import { ReloadTransactionStore, type ReloadReattachBundle } from "../host-action/reloadTransaction.js";

const RELOAD_ACTION = "reloadWindow";
const RELOAD_COMMAND = "workbench.action.reloadWindow";
const RELOAD_DEADLINE_MS = 30_000;

export interface VsCodeCommandShim {
  executeCommand(command: string): Promise<unknown>;
}

export class VsCodeHostActionAdapter implements HostActionPort {
  readonly adapterId = "agent-vscode";
  readonly available = true;

  constructor(
    private readonly shim: VsCodeCommandShim,
    private readonly transactions: ReloadTransactionStore,
    private readonly bundle: () => Omit<ReloadReattachBundle, "reattach_nonce">,
  ) {}

  async execute(envelope: HostActionExecutionEnvelope): Promise<HostActionPortResult> {
    if (envelope.action !== RELOAD_ACTION || envelope.command !== RELOAD_COMMAND || envelope.canonicalArgs !== "{}") {
      throw new HostActionError("adapter_failed", "agent-vscode adapter only accepts the broker envelope for reloadWindow");
    }
    await this.transactions.begin({
      actionId: envelope.actionId,
      command: envelope.command,
      bundle: this.bundle(),
      deadlineMs: RELOAD_DEADLINE_MS,
    });
    await this.shim.executeCommand(envelope.command);
    return { state: "disconnected", receipt: `reload-dispatched:${envelope.actionId}` };
  }
}
