/**
 * t-54cdb2 — destination scope for a plugin install plan.
 *
 * Authorization (who may *use* a plugin) already lives in `authorizeAgentPlugin`. This type is only
 * WHERE the engine writes: workspace-shared runtime dests vs one agent's private harness. Default is
 * workspace so existing installs stay byte-compatible. The lockfile may record the same plugin under
 * more than one dest scope (payload stays shared at `.tachyon/plugins/<name>/`).
 */

export type WorkspaceInstallScope = { type: "workspace" };
export type AgentInstallScope = { type: "agent"; name: string };
export type InstallScope = WorkspaceInstallScope | AgentInstallScope;

export const WORKSPACE_INSTALL_SCOPE: WorkspaceInstallScope = { type: "workspace" };

export function isAgentInstallScope(scope: InstallScope | undefined): scope is AgentInstallScope {
  return scope?.type === "agent";
}

export function sameInstallScope(a: InstallScope, b: InstallScope): boolean {
  if (a.type === "workspace" || b.type === "workspace") return a.type === b.type;
  return a.name === b.name;
}

export function parseInstallScope(raw: unknown, where: string): { scope?: InstallScope; error?: string } {
  if (raw === undefined) return { scope: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: `${where}: must be {type:"workspace"} or {type:"agent",name}` };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.type === "workspace") {
    if (rec.name !== undefined) return { error: `${where}.name: must be omitted for workspace scope` };
    return { scope: { type: "workspace" } };
  }
  if (rec.type === "agent") {
    if (typeof rec.name !== "string" || rec.name.length === 0) {
      return { error: `${where}.name: required agent name` };
    }
    return { scope: { type: "agent", name: rec.name } };
  }
  return { error: `${where}.type: must be "workspace" or "agent"` };
}

export function installScopeKey(scope: InstallScope): string {
  return scope.type === "workspace" ? "workspace" : `agent:${scope.name}`;
}
