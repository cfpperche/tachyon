import type { FormationSessionSelectorV1 } from "./domain.js";

export type FormationSessionOperation = "restart" | "resume" | "rebind" | "reanchor" | "fork";

export interface FormationSessionTransitionRequest {
  operation: FormationSessionOperation;
  ownerPrincipal: string;
  ownerKind: "human" | "system" | "agent";
  agentId: string;
  runtimeTrustClass: string;
  /** Rebind/fork may name the target transport session, but never another formation identity. */
  targetSessionId?: string;
  formationAffectingRuntimeChange?: boolean;
}

export type FormationSessionTransitionResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure operation boundary. Current profile bytes/generation are intentionally absent: existing
 * sessions select their immutable payload and do not refresh active formation state.
 */
export function validateFormationSessionTransition(
  selector: FormationSessionSelectorV1,
  request: FormationSessionTransitionRequest,
): FormationSessionTransitionResult {
  if (selector.revokedAt) return { ok: false, reason: "formation selector is revoked" };
  if (request.ownerPrincipal !== selector.ownerPrincipal || request.ownerKind !== selector.ownerKind) {
    return { ok: false, reason: "formation session ownership cannot transfer" };
  }
  if (request.agentId !== selector.agentId) return { ok: false, reason: "formation session cannot rebind to another agentId" };
  if (request.runtimeTrustClass !== selector.runtimeTrustClass) return { ok: false, reason: "runtime trust-class change requires a fresh formation" };
  if (request.formationAffectingRuntimeChange) return { ok: false, reason: "formation-affecting runtime change requires a fresh formation" };
  if (request.operation !== "rebind" && request.operation !== "fork" && request.targetSessionId !== undefined) {
    return { ok: false, reason: `${request.operation} cannot select another transport session` };
  }
  return { ok: true };
}

/** Plugin state is deliberately absent from the closed formation/session contract. */
export const FORMATION_GOVERNED_LANES = Object.freeze(["soul", "instructions", "evolution", "memory"] as const);
