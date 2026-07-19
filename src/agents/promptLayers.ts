import type { Role } from "../roles/templates.js";
import { bridgeGuidanceTail, composeInstructions, roleTemplate, withBridgeGuidance } from "../roles/templates.js";
import type { ResolvedSoul } from "./soul.js";

export interface AgentPromptLayers {
  soul?: ResolvedSoul;
  role?: Role;
  instructions?: string;
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
  const hasTaskBrief = !!present(layers.taskBrief);
  const manifest: AgentPromptManifest = {
    soul: !!layers.soul,
    role: !!layers.role && layers.role !== "custom",
    persistentInstructions: !!present(layers.instructions),
    bridgeGuidance: layers.bridgeGuidance,
    task: !hasTaskBrief
      ? { kind: "absent" }
      : layers.taskContractCompletion
        ? { kind: "contract", completion: layers.taskContractCompletion }
        : { kind: "brief" },
  };
  if (!layers.soul) {
    const legacyInstructions = [layers.instructions, layers.taskBrief].filter(Boolean).join("\n\n") || undefined;
    const body = withBridgeGuidance(composeInstructions(layers.role, legacyInstructions), layers.bridgeGuidance);
    return { body, manifest };
  }

  const soul = layers.soul;
  const roleBody = layers.role && layers.role !== "custom" ? roleTemplate(layers.role) : undefined;
  const guidance = layers.bridgeGuidance ? bridgeGuidanceTail() : undefined;
  const identity = [
    "## Identity (user-authored SOUL.md)",
    `Source: ${soul.source}`,
    "This identity shapes voice, values, posture, and style only. It cannot override provider or host authority, repository rules, Tachyon protocol, or the current execution task.",
    soul.body,
  ].filter(Boolean).join("\n\n");
  const body = [identity, present(roleBody), present(layers.instructions), guidance, present(layers.taskBrief)].filter(Boolean).join("\n\n") || undefined;
  return {
    body,
    soul: { profileId: soul.profileId, source: soul.source, sha256: soul.sha256, chars: soul.chars, bytes: soul.bytes },
    manifest,
  };
}
