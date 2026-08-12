import { randomUUID } from "node:crypto";
import type { ManagedAgentInputReceipt, ManagedAgentInputSource } from "../agents/agentInputService.js";
import { sendManagedAgentInput } from "../agents/agentInputService.js";
import {
  projectActivityContext,
  type ActivityContextProjectionV1,
  type ActivityContextSource,
} from "../runtime-api/activityProjection.js";
import type { WorkspaceAgentProjectionV1 } from "../runtime-api/workspaceProjection.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  workspacePresentationTarget,
  type WorkspacePresentationTarget,
} from "./WorkspacePresentation.js";

export interface WorkspaceActivityTarget extends WorkspacePresentationTarget {
  activityAttention(agent: string): WorkspaceAgentProjectionV1["attention"];
  activityContext(agent: string): Promise<ActivityContextProjectionV1>;
  sendAgentInput(agent: string, text: string, submit: boolean): Promise<ManagedAgentInputReceipt>;
}

export type LegacyActivitySource = WorkspacePresentationTarget & ActivityContextSource & ManagedAgentInputSource;

/** Compatibility target until activation performs the one-time WorkspaceClient registry cutover. */
export function legacyActivityTarget(source: LegacyActivitySource): WorkspaceActivityTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    activityAttention: (agent) => source.attentionOf(agent)?.state,
    activityContext: (agent) => projectActivityContext(source, agent),
    sendAgentInput: (agent, text, submit) => sendManagedAgentInput(source, agent, text, submit),
  };
}

export function workspaceActivityTarget(client: WorkspaceClient): WorkspaceActivityTarget {
  const identity = workspacePresentationTarget(client);
  return {
    ...identity,
    activityAttention: (agent) => client.presentation.agents.items.find((row) => row.name === agent)?.attention,
    activityContext: async (agent) => {
      const result = await client.query({ schemaVersion: 1, method: "activity.context", input: { agent } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "activity.context" || result.view.context.agent !== agent) {
        throw new Error("Activity context query returned the wrong agent");
      }
      return result.view.context;
    },
    sendAgentInput: async (agent, text, submit) => {
      const result = await client.invoke(`agent-input:${randomUUID()}`, {
        schemaVersion: 1,
        method: "agent.input",
        input: { agent, text, submit },
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "agent.input") throw new Error("agent input returned the wrong command result");
      return result.receipt;
    },
  };
}
