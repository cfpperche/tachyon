import type { HostActionExecutionEnvelope, HostActionPortResult } from "./types.js";

export interface HostActionPort {
  readonly adapterId: string;
  readonly available: boolean;
  execute(envelope: HostActionExecutionEnvelope): Promise<HostActionPortResult>;
}
