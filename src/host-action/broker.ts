import crypto from "node:crypto";
import { descriptorHash, validateCapabilityArgs } from "./capability.js";
import { DefaultDenyHostActionPolicy, type HostActionPolicySnapshot } from "./policy.js";
import type { HostActionAuditDecisionEvent, HostActionAuditSink } from "./audit.js";
import type { HostActionPort } from "./port.js";
import {
  HostActionError,
  type HostActionBrokerResult,
  type HostActionCaller,
  type HostActionCallerResolver,
  type HostActionDecisionChain,
  type HostActionExecutionEnvelope,
  type HostActionIdentityScope,
  type HostActionRequest,
  type HostActionErrorCode,
} from "./types.js";

export interface HostActionBrokerOptions {
  readonly callerResolver: HostActionCallerResolver;
  readonly policy?: HostActionPolicySnapshot;
  readonly audit: HostActionAuditSink;
  readonly port: HostActionPort;
  readonly randomId?: () => string;
  readonly validation?: { readonly maxBytes?: number; readonly maxDepth?: number };
}

export class HostActionBroker {
  private readonly callerResolver: HostActionCallerResolver;
  private readonly policy: HostActionPolicySnapshot;
  private readonly audit: HostActionAuditSink;
  private readonly port: HostActionPort;
  private readonly randomId: () => string;
  private readonly validation: { readonly maxBytes?: number; readonly maxDepth?: number };

  constructor(options: HostActionBrokerOptions) {
    this.callerResolver = options.callerResolver;
    this.policy = options.policy ?? new DefaultDenyHostActionPolicy();
    this.audit = options.audit;
    this.port = options.port;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.validation = options.validation ?? {};
  }

  async run(request: HostActionRequest, scope?: HostActionIdentityScope): Promise<HostActionBrokerResult> {
    const actionId = this.randomId();
    const delegatedBy = request.delegatedBy ?? [];
    const callerResolution = await this.callerResolver.resolve(request, scope);
    const requestedBy: HostActionDecisionChain["requested_by"] = callerResolution.ok
      ? callerResolution.caller
      : { unresolved: callerResolution.reason };
    const unresolvedDecision = this.baseDecision(requestedBy, delegatedBy);

    if (!callerResolution.ok) {
      return this.deny(actionId, request, unresolvedDecision, "caller_unresolved", callerResolution.reason);
    }
    if (request.expectedPolicyVersion !== undefined && request.expectedPolicyVersion !== this.policy.version) {
      return this.deny(actionId, request, unresolvedDecision, "policy_version_mismatch", "policy version changed before dispatch");
    }

    const spec = this.policy.capabilityFor(request.action);
    if (!spec) {
      return this.deny(actionId, request, unresolvedDecision, "capability_not_found", "host action is not enabled");
    }

    const specDescriptorHash = descriptorHash(spec);
    let validated;
    try {
      validated = validateCapabilityArgs(spec, request.args, this.validation);
    } catch (error) {
      const message = error instanceof HostActionError ? error.message : "host action args are invalid";
      const decision = this.decisionForSpec(callerResolution.caller, delegatedBy, spec.id, specDescriptorHash, "invalid");
      return this.deny(actionId, request, decision, "args_invalid", message);
    }

    const decision = this.decisionForSpec(callerResolution.caller, delegatedBy, spec.id, specDescriptorHash, validated.hash);
    const authorization = this.policy.authorize({ caller: callerResolution.caller, delegatedBy, spec, args: validated });
    if (!authorization.ok) {
      return this.deny(actionId, request, decision, "policy_denied", authorization.reason);
    }
    if (!this.port.available) {
      return this.deny(actionId, request, decision, "adapter_unavailable", "host action adapter is unavailable");
    }

    const auditRecord = await this.audit.appendBeforeExecute({
      kind: "decision",
      actionId,
      action: request.action,
      decision,
      allowed: true,
    });

    const envelope: HostActionExecutionEnvelope = {
      actionId,
      action: request.action,
      command: spec.command,
      canonicalArgs: validated.canonical,
      argsHash: validated.hash,
      specId: spec.id,
      descriptorHash: specDescriptorHash,
      decision,
    };

    try {
      const result = await this.withTimeout(this.port.execute(envelope), request.timeoutMs);
      const outcome = await this.audit.appendOutcome({
        kind: "outcome",
        actionId,
        state: result.state,
        receipt: result.receipt,
      });
      if (result.state === "result_unknown") {
        return {
          ok: false,
          code: "result_unknown",
          message: "host action result is unknown",
          actionId,
          auditSeq: auditRecord.seq,
          outcomeSeq: outcome.seq,
        };
      }
      return {
        ok: true,
        actionId,
        state: result.state,
        auditSeq: auditRecord.seq,
        outcomeSeq: outcome.seq,
        receipt: result.receipt,
      };
    } catch (error) {
      const code = error instanceof HostActionError ? error.code : "adapter_failed";
      const message = error instanceof Error ? error.message : "host action adapter failed";
      const outcome = await this.audit.appendOutcome({ kind: "outcome", actionId, state: "failed", code, message });
      return { ok: false, code, message, actionId, auditSeq: auditRecord.seq, outcomeSeq: outcome.seq };
    }
  }

  private async deny(
    actionId: string,
    request: HostActionRequest,
    decision: HostActionDecisionChain,
    code: HostActionErrorCode,
    message: string,
  ): Promise<HostActionBrokerResult> {
    const auditPayload: HostActionAuditDecisionEvent = {
      kind: "decision",
      actionId,
      action: request.action,
      decision,
      allowed: false,
      denialCode: code,
      denialReason: message,
    };
    const auditRecord = await this.audit.appendBeforeExecute(auditPayload);
    const outcome = await this.audit.appendOutcome({ kind: "outcome", actionId, state: "denied", code, message });
    return { ok: false, code, message, actionId, auditSeq: auditRecord.seq, outcomeSeq: outcome.seq };
  }

  private baseDecision(
    requestedBy: HostActionDecisionChain["requested_by"],
    delegatedBy: readonly HostActionCaller[],
  ): HostActionDecisionChain {
    return {
      requested_by: requestedBy,
      delegated_by: delegatedBy,
      policy_version: this.policy.version,
      policy_hash: this.policy.hash,
      spec_id: "none",
      descriptor_hash: "none",
      validated_args_hash: "none",
      executor_adapter: this.port.adapterId,
    };
  }

  private decisionForSpec(
    requestedBy: HostActionCaller,
    delegatedBy: readonly HostActionCaller[],
    specId: string,
    specDescriptorHash: string,
    argsHash: string,
  ): HostActionDecisionChain {
    return {
      requested_by: requestedBy,
      delegated_by: delegatedBy,
      policy_version: this.policy.version,
      policy_hash: this.policy.hash,
      spec_id: specId,
      descriptor_hash: specDescriptorHash,
      validated_args_hash: argsHash,
      executor_adapter: this.port.adapterId,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (timeoutMs === undefined) {
      return promise;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new HostActionError("timeout", "host action adapter timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
