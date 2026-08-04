/**
 * Workspace ops for the VS Code Chat → Tachyon bridge (shell-side).
 */

export type ChatBridgeAgentRow = {
  name: string;
  running?: boolean;
  kind?: string;
  lifetime?: string;
};

export type ChatBridgeWorkspace = {
  folderName: string;
  wsHash: string;
  workspaceRoot: string;
};

export type ChatBridgeOps = {
  /** Prefer the Control-scoped workspace, else first registered. */
  resolveWorkspace(wsHash?: string): ChatBridgeWorkspace | undefined;
  listAgents(wsHash?: string): Promise<ChatBridgeAgentRow[]>;
  /**
   * Deliver text to a named agent. `submit` defaults true (Enter after paste).
   * Throws on engine/refuse errors with a human/LLM-readable message.
   */
  sendPrompt(agent: string, text: string, opts?: { submit?: boolean; wsHash?: string }): Promise<void>;
};

export function normalizeAgentRows(listed: unknown): ChatBridgeAgentRow[] {
  if (!Array.isArray(listed)) return [];
  const out: ChatBridgeAgentRow[] = [];
  for (const raw of listed) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name.trim()) continue;
    out.push({
      name: row.name,
      running: typeof row.running === "boolean" ? row.running : undefined,
      kind: typeof row.kind === "string" ? row.kind : undefined,
      lifetime: typeof row.lifetime === "string" ? row.lifetime : undefined,
    });
  }
  return out;
}

/** Prefer declared runtime agents over bare terminals when picking defaults. */
export function preferredRunnableAgents(agents: ChatBridgeAgentRow[]): ChatBridgeAgentRow[] {
  const nonTerminal = agents.filter((a) => a.kind !== "terminal");
  return nonTerminal.length > 0 ? nonTerminal : agents;
}
