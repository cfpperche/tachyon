import type { RuntimeLaunchReadinessAdapter } from "../launchReadiness.js";

/** Classifies stable Codex terminal affordances only; it never retains pane text. */
export class CodexLaunchReadiness implements RuntimeLaunchReadinessAdapter {
  classify(output: string) {
    // Rejection wins if a stale ready prompt remains visible above the terminal error.
    if (/\b(?:unauthorized|authentication (?:failed|required)|not logged in|api key (?:is )?(?:invalid|missing)|access denied)\b/i.test(output)) {
      return { state: "rejected" as const, code: "runtime_auth_rejected" as const };
    }
    if (/\b(?:model .{0,80}(?:not found|unavailable|not available|unsupported)|unknown model|invalid model)\b/i.test(output)) {
      return { state: "rejected" as const, code: "runtime_model_rejected" as const };
    }
    if (/\b(?:invalid (?:configuration|config)|configuration (?:error|failed)|failed to (?:load|parse) (?:configuration|config))\b/i.test(output)) {
      return { state: "rejected" as const, code: "runtime_config_rejected" as const };
    }
    if (/(?:^|\n)\s*(?:›|>)?\s*(?:Ask anything|Type a message)\b/i.test(output)) return { state: "ready" as const };
    return undefined;
  }
}
