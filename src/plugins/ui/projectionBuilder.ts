import type { AgentVM, FleetVM } from "../../sidebar/types.js";
import type {
  PluginAgentAttentionV1,
  PluginAgentBadgeV1,
  PluginAgentProjectionV1,
  PluginAgentStatusV1,
  PluginFleetProjectionCountsV1,
  PluginFleetProjectionV1,
} from "./projectionTypes.js";

export interface PluginProjectionTarget {
  kind: "agent";
  fleetIndex: number;
  agentIndex: number;
  wsHash?: string;
  name: string;
}

export type PluginProjectionHandleMint = (target: PluginProjectionTarget, generation: number) => string;
export type PluginProjectionLabelMint = (target: PluginProjectionTarget) => string;

export function toPluginProjectionV1(
  fleet: FleetVM | readonly FleetVM[],
  generation: number,
  mintHandle: PluginProjectionHandleMint,
  mintLabel: PluginProjectionLabelMint = defaultLabel,
): PluginFleetProjectionV1 {
  const fleets: readonly FleetVM[] = isFleetArray(fleet) ? fleet : [fleet];
  const agents: PluginAgentProjectionV1[] = [];
  const counts = emptyCounts();

  fleets.forEach((oneFleet, fleetIndex) => {
    oneFleet.agents.forEach((agent, agentIndex) => {
      const status = toPluginStatus(agent.status);
      counts.agents += 1;
      counts[status] += 1;
      const target: PluginProjectionTarget = {
        kind: "agent",
        fleetIndex,
        agentIndex,
        ...(oneFleet.folder?.hash ? { wsHash: oneFleet.folder.hash } : {}),
        name: agent.name,
      };
      const attention = toPluginAttention(agent.attention, agent.status);
      agents.push({
        handle: mintHandle(target, generation),
        label: mintLabel(target),
        status,
        ...(attention ? { attention } : {}),
        badges: badgesFor(agent),
      });
    });
  });

  return { v: 1, generation, agents, counts };
}

function isFleetArray(fleet: FleetVM | readonly FleetVM[]): fleet is readonly FleetVM[] {
  return Array.isArray(fleet);
}

function emptyCounts(): PluginFleetProjectionCountsV1 {
  return { agents: 0, running: 0, needs: 0, throttled: 0, done: 0, idle: 0, stopped: 0, crashed: 0 };
}

function defaultLabel(target: PluginProjectionTarget): string {
  return `Agent ${target.fleetIndex + 1}-${target.agentIndex + 1}`;
}

function toPluginStatus(status: AgentVM["status"]): PluginAgentStatusV1 {
  if (status === "stopping" || status === "stop-failed") return "running";
  if (status === "done") return "done";
  return status;
}

function toPluginAttention(attention: string | undefined, status: AgentVM["status"]): PluginAgentAttentionV1 | undefined {
  const normalized = (attention ?? "").toLowerCase();
  if (status === "needs" || normalized.includes("needs")) return "needs-input";
  if (status === "throttled" || normalized.includes("thrott")) return "throttled";
  if (normalized.includes("working")) return "working";
  return undefined;
}

function badgesFor(agent: AgentVM): PluginAgentBadgeV1[] {
  const badges: PluginAgentBadgeV1[] = [];
  if (agent.verify === "pass") badges.push("verify-pass");
  if (agent.verify === "fail") badges.push("verify-fail");
  if (agent.verify === "stale") badges.push("verify-stale");
  if (agent.continuity === "fresh") badges.push("continuity-fresh");
  if (agent.continuity === "stale") badges.push("continuity-stale");
  if (agent.continuity === "missing") badges.push("continuity-missing");
  if (agent.persistenceHooks?.state === "active") badges.push("persistence-active");
  if (agent.persistenceHooks?.state === "skipped") badges.push("persistence-skipped");
  if (agent.persistenceHooks?.state === "failed") badges.push("persistence-failed");
  if (agent.evidence?.error) badges.push("evidence-error");
  else if (agent.evidence && (agent.evidence.warn || agent.evidence.stale)) badges.push("evidence-warn");
  if (agent.resumable) badges.push("resumable");
  if (agent.freshStart) badges.push("fresh-start");
  return badges;
}
