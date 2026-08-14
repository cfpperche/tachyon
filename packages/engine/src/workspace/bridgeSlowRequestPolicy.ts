import type { BridgeRequestCompleteInfo } from "../bridge/Bridge.js";

export const BRIDGE_EXTREME_SLOW_REQUEST_MS = 5 * 60 * 1000;
export const BRIDGE_SLOW_TOAST_DEDUPE_MS = 10 * 60 * 1000;

const LONG_RUNNING_TOOLS = new Set(["wait_for_agent"]);

export interface BridgeSlowRequestToast {
  message: string;
  dedupeKey: string;
}

export interface BridgeSlowRequestPolicyOptions {
  now?: number;
  extremeSlowMs?: number;
  dedupeMs?: number;
}

export class BridgeSlowRequestToastPolicy {
  private readonly lastToastAt = new Map<string, number>();

  constructor(private readonly options: BridgeSlowRequestPolicyOptions = {}) {}

  decide(info: BridgeRequestCompleteInfo): BridgeSlowRequestToast | undefined {
    if (!info.slow) return undefined;
    if (info.requestKind !== "mcp-tool") return undefined;
    if (info.tool && LONG_RUNNING_TOOLS.has(info.tool)) return undefined;
    if (info.durationMs < (this.options.extremeSlowMs ?? BRIDGE_EXTREME_SLOW_REQUEST_MS)) return undefined;

    const dedupeKey = `${info.tool ?? "unknown"}:${bridgeSlowRequestActor(info) ?? "unknown"}`;
    const now = this.options.now ?? Date.now();
    const last = this.lastToastAt.get(dedupeKey);
    if (last !== undefined && now - last < (this.options.dedupeMs ?? BRIDGE_SLOW_TOAST_DEDUPE_MS)) return undefined;
    this.lastToastAt.set(dedupeKey, now);

    return {
      dedupeKey,
      message: bridgeSlowRequestMessage(info),
    };
  }
}

export function bridgeSlowRequestMessage(info: BridgeRequestCompleteInfo): string {
  const parts = [info.tool ? `tool ${info.tool}` : "unknown tool"];
  const actor = bridgeSlowRequestActor(info);
  if (actor) parts.push(actor);
  parts.push(`${Math.round(info.durationMs)}ms`);
  return `Bridge request completed very slowly (${parts.join(", ")})`;
}

function bridgeSlowRequestActor(info: BridgeRequestCompleteInfo): string | undefined {
  if (info.caller?.kind === "agent" && info.caller.name) return `caller ${info.caller.name}`;
  if (info.caller?.kind && info.caller.kind !== "legacy") return `caller ${info.caller.kind}`;
  if (info.claimedIdentity) return `claimed ${info.claimedIdentity}`;
  if (info.caller?.kind === "legacy") return "caller legacy";
  return undefined;
}
