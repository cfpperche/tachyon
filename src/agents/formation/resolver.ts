import { composeAgentPrompt } from "@tachyon/engine/agents/promptLayers.js";
import type { ResolvedFormationPayload } from "@tachyon/engine/agents/formation/authorityStore.js";
import { formationDigest, validateFormationAuthorityVector, type FormationAuthorityVector } from "@tachyon/engine/agents/formation/domain.js";
import {
  HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
  type HumanLaneSuppressionAuthority,
  type HumanLaneSuppressionReceipt,
  resolveHumanFormationPayload,
} from "@tachyon/engine/agents/formation/humanLanes.js";
import { SELECTED_MEMORY_RENDERER_SHA256 } from "./memoryLane.js";

export const COMPLETE_FORMATION_RENDERER_CONTRACT = "tachyon-complete-agent-formation-v1";

export class CompleteFormationResolutionError extends Error {
  constructor(message: string) { super(message); this.name = "CompleteFormationResolutionError"; }
}

/** Digest of the exact lane renderer set and the one fixed composition order. */
export function completeFormationRendererContractsSha256(vector: FormationAuthorityVector): string {
  const memory = vector.profile.lanes.memory.mode === "profile";
  if (!memory) return HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256;
  return formationDigest({
    contract: COMPLETE_FORMATION_RENDERER_CONTRACT,
    human: HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
    memory: memory ? SELECTED_MEMORY_RENDERER_SHA256 : "disabled",
    order: ["instructions", "memory", "bridge-guidance", "task"],
    reanchor: "same-formation-without-task-v1",
  });
}

export interface ResolveCompleteFormationInput {
  operationId: string;
  workspaceRoot: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  vector: FormationAuthorityVector;
  bridgeGuidance: boolean;
  projectGuidance?: string;
  taskBrief?: string;
  taskContractCompletion?: "deliverable" | "done_when";
  runtimeTrustClass: string;
  suppressionAuthority: HumanLaneSuppressionAuthority;
  suppressionReceipt: HumanLaneSuppressionReceipt;
}

/** Resolves every enabled lane or fails the whole fresh formation; no partial payload exists. */
export async function resolveCompleteFormationPayload(input: ResolveCompleteFormationInput): Promise<ResolvedFormationPayload> {
  const vectorErrors = validateFormationAuthorityVector(input.vector);
  if (vectorErrors.length > 0) throw new CompleteFormationResolutionError(vectorErrors.join("; "));
  if (input.vector.profile.workspaceId !== input.workspaceId || input.vector.profile.agentId !== input.agentId
    || input.vector.profile.agentName !== input.agentName) {
    throw new CompleteFormationResolutionError("formation request identity does not match the active vector");
  }
  const rendererContractsSha256 = completeFormationRendererContractsSha256(input.vector);
  if (input.vector.generation.rendererContractsSha256 !== rendererContractsSha256) {
    throw new CompleteFormationResolutionError("formation generation does not bind the complete renderer set");
  }

  const human = await resolveHumanFormationPayload({
    ...input,
    expectedRendererContractsSha256: rendererContractsSha256,
  });
  if (input.vector.profile.lanes.memory.mode === "profile") {
    throw new CompleteFormationResolutionError("selected-memory store was removed (t-56ced4); an enabled memory lane cannot resolve");
  }

  const layers = {
    instructions: human.instructions?.body,
    bridgeGuidance: input.bridgeGuidance,
  };
  const startupBody = composeAgentPrompt({
    ...layers,
    taskBrief: input.taskBrief,
    taskContractCompletion: input.taskContractCompletion,
  }).body;
  const reanchorBody = composeAgentPrompt(layers).body;
  const startupPrompt = [input.projectGuidance, startupBody].filter((value): value is string => !!value?.trim()).join("\n\n");
  const reminderBody = [input.projectGuidance, reanchorBody].filter((value): value is string => !!value?.trim()).join("\n\n");
  return {
    sourceVectorSha256: formationDigest(input.vector),
    rendererContractsSha256,
    startupPrompt,
    reanchorReminder: ["── AGENT FORMATION REMINDER V1 ──", reminderBody, "── END AGENT FORMATION REMINDER V1 ──"].join("\n"),
    nativeSuppression: structuredClone(human.suppression),
  };
}
