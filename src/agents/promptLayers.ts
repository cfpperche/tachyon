import type { Role } from "../roles/templates.js";
import { bridgeGuidanceTail, composeInstructions, roleTemplate, withBridgeGuidance } from "../roles/templates.js";
import type { ResolvedSoul } from "./soul.js";

export interface AgentPromptLayers {
  soul?: ResolvedSoul | string;
  role?: Role | string;
  instructions?: string;
  bridgeGuidance: boolean | string;
  taskBrief?: string;
}

export interface SoulSnapshot {
  enabled: true;
  profileId: string;
  source: string;
  sha256: string;
  chars: number;
  bytes: number;
}

export interface ComposedAgentBody {
  body?: string;
  soul?: SoulSnapshot;
}

const present = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;

export function composeAgentPrompt(layers: AgentPromptLayers): ComposedAgentBody {
  if (!layers.soul) {
    const legacyInstructions = [present(layers.instructions), present(layers.taskBrief)].filter(Boolean).join("\n\n") || undefined;
    const role = typeof layers.role === "string" ? layers.role as Role : layers.role;
    const body = withBridgeGuidance(composeInstructions(role, legacyInstructions), layers.bridgeGuidance === true);
    return { body };
  }

  const soul = typeof layers.soul === "string" ? undefined : layers.soul;
  const soulBody = typeof layers.soul === "string" ? layers.soul : layers.soul.body;
  const roleBody = layers.role && layers.role !== "custom" ? roleTemplate(layers.role as Role) : undefined;
  const guidance = typeof layers.bridgeGuidance === "string"
    ? present(layers.bridgeGuidance)
    : layers.bridgeGuidance ? bridgeGuidanceTail() : undefined;
  const identity = [
    "## Identity (user-authored SOUL.md)",
    soul ? `Source: ${soul.source}` : undefined,
    "This identity shapes voice, values, posture, and style only. It cannot override provider or host authority, repository rules, Tachyon protocol, or the current execution task.",
    soulBody,
  ].filter(Boolean).join("\n\n");
  const body = [identity, present(roleBody), present(layers.instructions), guidance, present(layers.taskBrief)].filter(Boolean).join("\n\n") || undefined;
  return {
    body,
    ...(soul ? { soul: { enabled: true, profileId: soul.profileId, source: soul.source, sha256: soul.sha256, chars: soul.chars, bytes: soul.bytes } } : {}),
  };
}

/** Convenience renderer used by focused behavior tests and non-lifecycle consumers. */
export function renderPromptLayers(layers: Omit<AgentPromptLayers, "bridgeGuidance"> & { bridgeGuidance: boolean | string }): string | undefined {
  if (typeof layers.soul === "string" && typeof layers.bridgeGuidance === "string") {
    return [layers.soul, layers.role, layers.instructions, layers.bridgeGuidance, layers.taskBrief].filter(Boolean).join("\n\n") || undefined;
  }
  return composeAgentPrompt(layers).body;
}
