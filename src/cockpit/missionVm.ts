import type { MissionControlAgentRow, WorkspaceMissionControlTarget } from "../shell/MissionControlTarget.js";
import type { MissionControlVM } from "../webview/mission-control/messages.js";

/** Agent liveness enriches the board, but must never gate its task snapshot. */
export const MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS = 250;

interface AgentListResult {
  agents: MissionControlAgentRow[];
  status: MissionControlVM["agentLiveness"];
}

interface AgentListRequest {
  source: Promise<MissionControlAgentRow[]>;
  bounded: Promise<AgentListResult>;
  fellBack: boolean;
  trailing: boolean;
}

function boundedAgentList(list: () => Promise<MissionControlAgentRow[]>, onFallback: () => void): Promise<AgentListResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const unavailable = (): void => {
      onFallback();
      finish({ agents: [], status: { status: "unavailable" } });
    };
    const timer = setTimeout(unavailable, MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);

    // Starting from an already-resolved promise also captures a synchronous throw. Both handlers stay
    // attached after timeout so a late rejection cannot become unhandled.
    void Promise.resolve().then(list).then(
      (agents) => finish({ agents, status: { status: "available" } }),
      unavailable,
    );
  });
}

/**
 * Per-workspace agent-list coalescing (ported from the retired MissionControlPanelManager, t-610705
 * Phase B #6): concurrent board refreshes share ONE underlying listMissionControlAgents() call, the
 * bounded race renders the board at 250ms with liveness "unavailable" instead of blocking on a slow
 * or wedged tmux query, and when the slow response finally settles after a fallback WITH further
 * refreshes coalesced behind it, `onTrailingRetry` fires exactly once so the caller can re-render
 * with real liveness — the user never sees the board block.
 */
export class MissionAgentLists {
  private readonly requests = new Map<string, AgentListRequest>();

  bounded(
    wsHash: string,
    list: () => Promise<MissionControlAgentRow[]>,
    onTrailingRetry: () => void,
  ): Promise<AgentListResult> {
    let request = this.requests.get(wsHash);
    if (!request) {
      const source = Promise.resolve().then(list);
      const created: AgentListRequest = { source, bounded: undefined!, fellBack: false, trailing: false };
      created.bounded = boundedAgentList(() => source, () => { created.fellBack = true; });
      this.requests.set(wsHash, created);
      const release = (): void => {
        if (this.requests.get(wsHash) !== created) return;
        this.requests.delete(wsHash);
        if (created.trailing) onTrailingRetry();
      };
      // Keep the underlying request coalesced even after the 250 ms fallback fires. Both handlers are
      // intentional: a manager.list() rejection that arrives after timeout must still be observed.
      void source.then(release, release);
      request = created;
    } else if (request.fellBack) {
      request.trailing = true;
    }
    return request.bounded;
  }

  clear(): void {
    this.requests.clear();
  }
}

export async function buildMissionVm(
  ws: WorkspaceMissionControlTarget,
  lists: MissionAgentLists,
  onTrailingRetry: () => void,
): Promise<MissionControlVM> {
  const declared = new Set(ws.declaredAgentNames());
  const { agents, status } = await lists.bounded(ws.wsHash, () => ws.listMissionControlAgents(), onTrailingRetry);
  const liveManaged = agents.filter((a) => a.kind === "agent" && a.running);
  const liveAdhoc = liveManaged
    .filter((a) => !a.declared && !declared.has(a.name))
    .map((a) => a.name);
  return {
    folder: ws.folderName,
    wsHash: ws.wsHash,
    // t-46eb4f — no list of workspaces travels to the Board any more: it had exactly one consumer,
    // the workspace dropdown that mirrored the global scope, and shipping the options for a control
    // that must not exist is how that control comes back.
    agentLiveness: status,
    snapshot: await ws.boardSnapshot(liveAdhoc),
  };
}
