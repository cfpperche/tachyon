import type { HostActionCapabilitySpec, ValidatedHostActionArgs } from "./capability.js";
import type { HostActionCaller } from "./types.js";

export interface HostActionPolicySnapshot {
  readonly version: string;
  readonly hash: string;
  capabilityFor(action: string): HostActionCapabilitySpec | undefined;
  authorize(input: HostActionAuthorizationInput): HostActionAuthorizationResult;
}

export interface HostActionAuthorizationInput {
  readonly caller: HostActionCaller;
  readonly delegatedBy: readonly HostActionCaller[];
  readonly spec: HostActionCapabilitySpec;
  readonly args: ValidatedHostActionArgs;
}

export type HostActionAuthorizationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export class DefaultDenyHostActionPolicy implements HostActionPolicySnapshot {
  readonly version = "default-deny";
  readonly hash = "default-deny";

  capabilityFor(): HostActionCapabilitySpec | undefined {
    return undefined;
  }

  authorize(): HostActionAuthorizationResult {
    return { ok: false, reason: "host actions are disabled by default" };
  }
}

export class StaticHostActionPolicy implements HostActionPolicySnapshot {
  readonly version: string;
  readonly hash: string;
  private readonly capabilities: ReadonlyMap<string, HostActionCapabilitySpec>;
  private readonly allowedAgents: ReadonlySet<string>;

  constructor(input: {
    readonly version: string;
    readonly hash: string;
    readonly capabilities: readonly HostActionCapabilitySpec[];
    readonly allowedAgents?: readonly string[];
  }) {
    this.version = input.version;
    this.hash = input.hash;
    this.capabilities = new Map(input.capabilities.map((spec) => [spec.action, spec]));
    this.allowedAgents = new Set(input.allowedAgents ?? []);
  }

  capabilityFor(action: string): HostActionCapabilitySpec | undefined {
    return this.capabilities.get(action);
  }

  authorize(input: HostActionAuthorizationInput): HostActionAuthorizationResult {
    if (this.allowedAgents.size === 0) {
      return { ok: false, reason: "policy has no agent grant" };
    }
    // Host actions require a resolved agent principal (Bridge agent-scoped token).
    // Legacy/master tokens are never enough for this privileged surface.
    if (input.caller.kind !== "agent" || !input.caller.name) {
      return { ok: false, reason: "caller is not granted this host action" };
    }
    // "*" = any resolved agent principal (declared or ad-hoc with identity).
    // Explicit names remain available for tests and tighter pins.
    if (this.allowedAgents.has("*") || this.allowedAgents.has(input.caller.name)) {
      return { ok: true };
    }
    return { ok: false, reason: "caller is not granted this host action" };
  }
}
