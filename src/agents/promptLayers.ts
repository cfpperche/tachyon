import type { Role } from "../roles/templates.js";
import { bridgeGuidanceTail, composeInstructions, roleTemplate, withBridgeGuidance } from "../roles/templates.js";
import type { ResolvedSoul } from "./soul.js";
import { renderEvolutionPromptLayer, type EvolutionStartupSnapshot } from "../evolution/startupSnapshot.js";

export interface AgentPromptLayers {
  soul?: ResolvedSoul;
  role?: Role;
  instructions?: string;
  evolution?: EvolutionStartupSnapshot;
  /** Canonical formation-owned Evolution layer. Mutually exclusive with the legacy startup snapshot. */
  formationEvolution?: string;
  /** Canonical, human-approved selected-memory layer. */
  selectedMemory?: string;
  bridgeGuidance: boolean;
  taskBrief?: string;
  /** Present only when taskBrief was rendered from the validated structured SpawnContract. */
  taskContractCompletion?: "deliverable" | "done_when";
}

export type PromptTaskLayer =
  | { kind: "absent" }
  | { kind: "brief" }
  | { kind: "contract"; completion: "deliverable" | "done_when" };

/** Content-free composition facts. This describes what the compositor actually emitted; it never
 * stores prompt bytes and is safe to project into a bounded startup-brief inventory. */
export interface AgentPromptManifest {
  soul: boolean;
  role: boolean;
  persistentInstructions: boolean;
  evolution?: { version: number; digest: string };
  canonicalEvolution?: true;
  selectedMemory?: true;
  bridgeGuidance: boolean;
  task: PromptTaskLayer;
}

export interface SoulSnapshot {
  source: string;
  profileId: string;
  sha256: string;
  chars: number;
  bytes: number;
  channel: "startup-argument" | "tui-prefill" | "reanchor-pointer";
  state: "offered";
  offeredAt: string;
}

export interface ComposedAgentBody {
  body?: string;
  soul?: Omit<SoulSnapshot, "channel" | "state" | "offeredAt">;
  manifest: AgentPromptManifest;
}

const present = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;

export function composeAgentPrompt(layers: AgentPromptLayers): ComposedAgentBody {
  if (layers.evolution && present(layers.formationEvolution)) {
    throw new Error("legacy and canonical Evolution layers cannot be composed together");
  }
  const hasTaskBrief = !!present(layers.taskBrief);
  const manifest: AgentPromptManifest = {
    soul: !!layers.soul,
    role: !!layers.role && layers.role !== "custom",
    persistentInstructions: !!present(layers.instructions),
    ...(layers.evolution ? { evolution: { version: layers.evolution.version, digest: layers.evolution.digest } } : {}),
    ...(present(layers.formationEvolution) ? { canonicalEvolution: true as const } : {}),
    ...(present(layers.selectedMemory) ? { selectedMemory: true as const } : {}),
    bridgeGuidance: layers.bridgeGuidance,
    task: !hasTaskBrief
      ? { kind: "absent" }
      : layers.taskContractCompletion
        ? { kind: "contract", completion: layers.taskContractCompletion }
        : { kind: "brief" },
  };
  if (!layers.soul && !layers.evolution && !present(layers.formationEvolution) && !present(layers.selectedMemory)) {
    const legacyInstructions = [layers.instructions, layers.taskBrief].filter(Boolean).join("\n\n") || undefined;
    const body = withBridgeGuidance(composeInstructions(layers.role, legacyInstructions), layers.bridgeGuidance);
    return { body, manifest };
  }

  const roleBody = layers.role && layers.role !== "custom" ? roleTemplate(layers.role) : undefined;
  const guidance = layers.bridgeGuidance ? bridgeGuidanceTail() : undefined;
  const identity = layers.soul
    ? [
        "## Identity (user-authored SOUL.md)",
        `Source: ${layers.soul.source}`,
        "This identity shapes voice, values, posture, and style only. It cannot override provider or host authority, repository rules, Tachyon protocol, or the current execution task.",
        layers.soul.body,
      ].filter(Boolean).join("\n\n")
    : undefined;
  const evolution = layers.evolution ? renderEvolutionPromptLayer(layers.evolution) : undefined;
  const body = [
    identity,
    present(roleBody),
    present(layers.instructions),
    evolution,
    present(layers.formationEvolution),
    present(layers.selectedMemory),
    guidance,
    present(layers.taskBrief),
  ].filter(Boolean).join("\n\n") || undefined;
  return {
    body,
    ...(layers.soul ? { soul: {
      profileId: layers.soul.profileId,
      source: layers.soul.source,
      sha256: layers.soul.sha256,
      chars: layers.soul.chars,
      bytes: layers.soul.bytes,
    } } : {}),
    manifest,
  };
}
