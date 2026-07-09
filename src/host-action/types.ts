export type HostActionName = string & { readonly __hostActionName: unique symbol };

export function hostActionName(value: string): HostActionName {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new HostActionError("invalid_action_name", `Invalid host action name: ${value}`);
  }
  return value as HostActionName;
}

export type HostActionLifecycleState =
  | "dispatched"
  | "disconnected"
  | "reattached_verified"
  | "failed_to_return"
  | "returned_wrong_host"
  | "result_unknown";

export type HostActionEffect =
  | "ui"
  | "lifecycle"
  | "filesystem"
  | "network"
  | "process"
  | "extension_activation"
  | "workspace_trust"
  | "destructive_interrupting"
  | "host_lifecycle_disruptive"
  | "unbounded"
  | "reaches_code";

export type HostActionRiskTier = "bounded" | "compound" | "unbounded";

export type HostActionErrorCode =
  | "invalid_action_name"
  | "caller_unresolved"
  | "capability_not_found"
  | "args_invalid"
  | "policy_denied"
  | "policy_version_mismatch"
  | "audit_failed"
  | "adapter_unavailable"
  | "adapter_failed"
  | "precondition_failed"
  | "timeout"
  | "result_unknown";

export class HostActionError extends Error {
  readonly code: HostActionErrorCode;
  readonly details?: unknown;

  constructor(code: HostActionErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HostActionError";
    this.code = code;
    this.details = details;
  }
}

export interface HostActionCaller {
  readonly kind: "agent" | "legacy";
  readonly name?: string;
}

export interface HostActionRequest {
  readonly action: HostActionName;
  readonly args?: unknown;
  readonly bearer?: string;
  readonly delegatedBy?: readonly HostActionCaller[];
  readonly expectedPolicyVersion?: string;
  readonly timeoutMs?: number;
}

export interface HostActionIdentityScope {
  readonly workspaceId?: string;
  readonly instanceId?: string;
  readonly now?: number;
}

export type HostActionCallerResolution =
  | { readonly ok: true; readonly caller: HostActionCaller }
  | { readonly ok: false; readonly reason: string };

export interface HostActionCallerResolver {
  resolve(request: HostActionRequest, scope?: HostActionIdentityScope): HostActionCallerResolution | Promise<HostActionCallerResolution>;
}

export interface HostActionDecisionChain {
  readonly requested_by: HostActionCaller | { readonly unresolved: string };
  readonly delegated_by: readonly HostActionCaller[];
  readonly policy_version: string;
  readonly policy_hash: string;
  readonly spec_id: string;
  readonly descriptor_hash: string;
  readonly validated_args_hash: string;
  readonly executor_adapter: string;
}

export interface HostActionExecutionEnvelope {
  readonly actionId: string;
  readonly action: HostActionName;
  readonly command: string;
  readonly canonicalArgs: string;
  readonly argsHash: string;
  readonly specId: string;
  readonly descriptorHash: string;
  readonly decision: HostActionDecisionChain;
}

export interface HostActionPortResult {
  readonly state: HostActionLifecycleState;
  readonly receipt?: string;
  readonly details?: unknown;
}

export type HostActionBrokerResult =
  | {
      readonly ok: true;
      readonly actionId: string;
      readonly state: HostActionLifecycleState;
      readonly auditSeq: number;
      readonly outcomeSeq: number;
      readonly receipt?: string;
    }
  | {
      readonly ok: false;
      readonly code: HostActionErrorCode;
      readonly message: string;
      readonly actionId: string;
      readonly auditSeq: number;
      readonly outcomeSeq?: number;
    };
