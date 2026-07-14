import type { Role } from "../roles/templates.js";
import { bridgeGuidanceTail, composeInstructions, roleTemplate, withBridgeGuidance } from "../roles/templates.js";
import type { ResolvedSoul } from "./soul.js";

export interface AgentPromptLayers {
  soul?: ResolvedSoul;
  role?: Role;
  instructions?: string;
  bridgeGuidance: boolean;
  taskBrief?: string;
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
}

const present = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;

export function composeAgentPrompt(layers: AgentPromptLayers): ComposedAgentBody {
  if (!layers.soul) {
    const legacyInstructions = [layers.instructions, layers.taskBrief].filter(Boolean).join("\n\n") || undefined;
    const body = withBridgeGuidance(composeInstructions(layers.role, legacyInstructions), layers.bridgeGuidance);
    return { body };
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
  };
}
