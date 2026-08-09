import crypto from "node:crypto";
import { bridgeGuidanceTail } from "./bridgeGuidance.js";
import { briefCarriesTaskSubstance } from "../bridge/spawnContract.js";
import { renderEvolutionPromptLayer, type EvolutionStartupSnapshot } from "../evolution/startupSnapshot.js";
import { renderSessionWorkRecord, sessionRecordManifest, type SessionWorkRecord } from "./sessionWorkRecord.js";

export interface AgentPromptLayers {
  instructions?: string;
  /**
   * Authority receipt for FORMATION-adopted instructions. Absent means the bytes came from the
   * agent's own definition — for a canonical agent, the pinned `instructions.md` its profile names
   * (t-d48775); an unadopted agent remains a valid, explicitly non-formation composition.
   */
  instructionsFormation?: {
    source: "formation";
    agentId: string;
    workspaceId: string;
    formationGeneration: number;
    formationGenerationSha256: string;
  };
  evolution?: EvolutionStartupSnapshot;
  /** Canonical formation-owned Evolution layer. Mutually exclusive with the legacy startup snapshot. */
  formationEvolution?: string;
  /** Canonical, human-approved selected-memory layer. */
  selectedMemory?: string;
  bridgeGuidance: boolean;
  taskBrief?: string;
  /** Present only when taskBrief was rendered from the validated structured SpawnContract. */
  taskContractCompletion?: "deliverable" | "done_when";
  /** t-e3aaae — durable work record for a session:new restart (isolation + assigned board tasks). */
  sessionWorkRecord?: SessionWorkRecord;
}

export type PromptTaskLayer =
  | { kind: "absent" }
  | { kind: "brief" }
  | { kind: "contract"; completion: "deliverable" | "done_when" };

/** Content-free composition facts. This describes what the compositor actually emitted; it never
 * stores prompt bytes and is safe to project into a bounded startup-brief inventory. */
export interface AgentPromptManifest {
  persistentInstructions: boolean;
  instructions?:
    | { source: "profile-definition"; sha256: string }
    | {
        source: "formation";
        sha256: string;
        agentId: string;
        workspaceId: string;
        formationGeneration: number;
        formationGenerationSha256: string;
      };
  evolution?: { version: number; digest: string };
  canonicalEvolution?: true;
  selectedMemory?: true;
  bridgeGuidance: boolean;
  task: PromptTaskLayer;
  /** t-e3aaae — present when a restart materialized the durable work record into the brief. */
  sessionRecord?: { isolation: "worktree" | "shared"; assignedTaskIds: string[]; assignedCount: number };
}

export interface ComposedAgentBody {
  body?: string;
  manifest: AgentPromptManifest;
}

const present = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;
const sha256 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

export function composeAgentPrompt(layers: AgentPromptLayers): ComposedAgentBody {
  if (layers.evolution && present(layers.formationEvolution)) {
    throw new Error("legacy and canonical Evolution layers cannot be composed together");
  }
  // t-e3aaae — a brief carries a task only when something other than the fixed protocol boilerplate
  // survives in it. A validated contract is substance by construction; anything else must prove it,
  // so a boilerplate-only row can never announce itself as `task brief (present)`.
  const hasTaskBrief = !!layers.taskContractCompletion || briefCarriesTaskSubstance(present(layers.taskBrief));
  const sessionRecord = layers.sessionWorkRecord
    ? renderSessionWorkRecord({ ...layers.sessionWorkRecord, hasTaskBrief })
    : undefined;
  const instructions = present(layers.instructions);
  const manifest: AgentPromptManifest = {
    persistentInstructions: !!instructions,
    ...(instructions ? {
      instructions: layers.instructionsFormation
        ? { ...layers.instructionsFormation, sha256: sha256(instructions) }
        // t-d48775 — this used to read `legacy-definition`, and that name stopped being true the day
        // the inline agent format was removed: nothing legacy can reach this branch, and what does
        // reach it is the profile's own pinned document. A manifest the agent reads about itself is
        // exactly the wrong place to keep a label that names a mechanism the product no longer has.
        : { source: "profile-definition" as const, sha256: sha256(instructions) },
    } : {}),
    ...(layers.evolution ? { evolution: { version: layers.evolution.version, digest: layers.evolution.digest } } : {}),
    ...(present(layers.formationEvolution) ? { canonicalEvolution: true as const } : {}),
    ...(present(layers.selectedMemory) ? { selectedMemory: true as const } : {}),
    bridgeGuidance: layers.bridgeGuidance,
    task: !hasTaskBrief
      ? { kind: "absent" }
      : layers.taskContractCompletion
        ? { kind: "contract", completion: layers.taskContractCompletion }
        : { kind: "brief" },
    ...(layers.sessionWorkRecord ? { sessionRecord: sessionRecordManifest(layers.sessionWorkRecord) } : {}),
  };
  const guidance = layers.bridgeGuidance ? bridgeGuidanceTail() : undefined;
  const evolution = layers.evolution ? renderEvolutionPromptLayer(layers.evolution) : undefined;
  const body = [
    instructions,
    evolution,
    present(layers.formationEvolution),
    present(layers.selectedMemory),
    guidance,
    present(layers.taskBrief),
    // Last in the body: the durable work record is the most recent thing a restarted session knows.
    sessionRecord,
  ].filter(Boolean).join("\n\n") || undefined;
  return { body, manifest };
}
