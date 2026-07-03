import type { NextValidationResult, Validation } from "./types.js";

export interface NextValidationInput {
  validations: Validation[];
  agent: string;
}

export function nextValidation(input: NextValidationInput): NextValidationResult {
  const open = input.validations.filter((v) => v.status === "triaged" || v.status === "running");
  if (open.length === 0) return { empty: true, reason: "no-validations" };
  const executable = open.filter((v) => canAgentRun(v, input.agent));
  if (executable.length === 0) {
    return { empty: true, reason: open.every((v) => v.executor === "human" || v.assignee === "human") ? "all-human-only" : "all-assigned-elsewhere" };
  }
  return { validation: executable.slice().sort(compareValidations)[0] };
}

export function compareValidations(a: Validation, b: Validation): number {
  const ap = a.priority ?? Number.POSITIVE_INFINITY;
  const bp = b.priority ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  const ac = Date.parse(a.createdAt);
  const bc = Date.parse(b.createdAt);
  if (Number.isFinite(ac) && Number.isFinite(bc) && ac !== bc) return ac - bc;
  return a.id.localeCompare(b.id);
}

function canAgentRun(v: Validation, agent: string): boolean {
  if (v.executor === "human") return agent === "human";
  if (agent !== "human" && v.executor === "agent") {
    if (v.assignee && v.assignee !== agent) return false;
    return true;
  }
  if (v.executor === "either") {
    if (v.assignee && v.assignee !== agent) return false;
    return true;
  }
  return false;
}
