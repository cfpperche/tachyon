import type { AgentVM } from "@tachyon/shared/sidebar/types";

export function agentGroupParent(a: AgentVM): string | undefined {
  return a.parent ?? a.delegator ?? a.declaredOwner;
}

export function agentIsNested(a: AgentVM, names: ReadonlySet<string>): boolean {
  const p = agentGroupParent(a);
  return !!p && p !== a.name && names.has(p);
}

export interface AgentHierarchyRow {
  agent: AgentVM;
  nested: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  hiddenCount: number;
  hiddenNeedsAttention: boolean;
}

function agentNeedsAttention(a: AgentVM): boolean {
  return !!a.attention || !!a.awaitingHuman || !!a.authRequired || a.status === "needs" || a.status === "throttled";
}

function directChildrenOf(agents: readonly AgentVM[]): Map<string, AgentVM[]> {
  const names = new Set(agents.map((a) => a.name));
  const children = new Map<string, AgentVM[]>();
  for (const a of agents) {
    const p = agentGroupParent(a);
    if (!p || p === a.name || !names.has(p)) continue;
    const list = children.get(p);
    if (list) list.push(a);
    else children.set(p, [a]);
  }
  return children;
}

function visitDescendants(children: ReadonlyMap<string, readonly AgentVM[]>, name: string, visit: (a: AgentVM) => void, seen = new Set<string>()): void {
  if (seen.has(name)) return;
  seen.add(name);
  for (const child of children.get(name) ?? []) {
    visit(child);
    visitDescendants(children, child.name, visit, seen);
  }
}

export function agentAncestorNames(agents: readonly AgentVM[], name: string): string[] {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const out: string[] = [];
  const seen = new Set<string>([name]);
  let cur = byName.get(name);
  while (cur) {
    const p = agentGroupParent(cur);
    if (!p || p === cur.name || seen.has(p) || !byName.has(p)) break;
    out.push(p);
    seen.add(p);
    cur = byName.get(p);
  }
  return out;
}

export function agentHierarchyRows(agents: readonly AgentVM[], collapsedParents: ReadonlySet<string>): AgentHierarchyRow[] {
  const names = new Set(agents.map((a) => a.name));
  const children = directChildrenOf(agents);
  const out: AgentHierarchyRow[] = [];

  for (const agent of agents) {
    const ancestors = agentAncestorNames(agents, agent.name);
    if (ancestors.some((p) => collapsedParents.has(p))) continue;

    let hiddenCount = 0;
    let hiddenNeedsAttention = false;
    if (collapsedParents.has(agent.name)) {
      visitDescendants(children, agent.name, (child) => {
        hiddenCount += 1;
        hiddenNeedsAttention = hiddenNeedsAttention || agentNeedsAttention(child);
      });
    }

    out.push({
      agent,
      nested: agentIsNested(agent, names),
      hasChildren: (children.get(agent.name)?.length ?? 0) > 0,
      collapsed: collapsedParents.has(agent.name),
      hiddenCount,
      hiddenNeedsAttention,
    });
  }

  return out;
}
