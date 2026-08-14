import { HostActionError, type HostActionExecutionEnvelope, type HostActionLifecycleState, type HostActionPortResult } from "./types.js";
import type { HostActionPort } from "./port.js";

export class AgentNoopHostActionPort implements HostActionPort {
  readonly adapterId: string;
  available: boolean;
  readonly envelopes: HostActionExecutionEnvelope[] = [];
  private readonly state: HostActionLifecycleState;

  constructor(input: { readonly adapterId?: string; readonly available?: boolean; readonly state?: HostActionLifecycleState } = {}) {
    this.adapterId = input.adapterId ?? "agent-noop";
    this.available = input.available ?? true;
    this.state = input.state ?? "dispatched";
  }

  async execute(envelope: HostActionExecutionEnvelope): Promise<HostActionPortResult> {
    if (!this.available) {
      throw new HostActionError("adapter_unavailable", "Host action adapter is unavailable");
    }
    this.envelopes.push(envelope);
    return { state: this.state, receipt: `${this.adapterId}:${envelope.actionId}` };
  }
}
