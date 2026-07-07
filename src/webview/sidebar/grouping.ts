import type { AgentVM } from "../../sidebar/types";

export function agentGroupParent(a: AgentVM): string | undefined {
  return a.parent ?? a.delegator ?? a.declaredOwner;
}

export function agentIsNested(a: AgentVM, names: ReadonlySet<string>): boolean {
  const p = agentGroupParent(a);
  return !!p && p !== a.name && names.has(p);
}
