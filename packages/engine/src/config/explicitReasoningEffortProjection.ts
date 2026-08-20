import { adapterFor } from "@tachyon/shared/resume/adapters.js";
import { claudeSelectorNativeConfigPolicy, codexSelectorNativeConfigPolicy, grokSelectorNativeConfigPolicy, projectAgentNativeConfig, type ResolvedAgentNativeConfigProjection } from "@tachyon/shared/config/agentNativeConfigPolicy.js";
import { projectClaudeNativeConfig } from "./claudeNativeConfigProjection.js";
import { projectGrokNativeConfig } from "./grokNativeConfigProjection.js";

/** Project an explicit Temporary-agent selector through the profile projector and its guards. */
export function explicitReasoningEffortProjection(command: string, reasoningEffort: string): ResolvedAgentNativeConfigProjection {
  const runtime = adapterFor(command)?.runtime;
  if (runtime !== "codex" && runtime !== "claude" && runtime !== "grok") throw new Error(`reasoningEffort is unsupported for runtime '${runtime ?? command}'`);
  const nativeConfig = { selectors: runtime === "codex" ? codexSelectorNativeConfigPolicy() : runtime === "claude" ? claudeSelectorNativeConfigPolicy() : grokSelectorNativeConfigPolicy() };
  const profile = { runtime: { adapter: runtime, executable: runtime, reasoningEffort }, nativeConfig } as const;
  const base = projectAgentNativeConfig(profile)!;
  if (runtime === "claude") {
    const result = projectClaudeNativeConfig(profile, {}, base);
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    return result.projection;
  }
  if (runtime === "grok") {
    const result = projectGrokNativeConfig(profile, {}, base);
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    return result.projection;
  }
  return base;
}
