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

    // Codex rotates the composer placeholder (for example "Implement {feature}"), so the
    // placeholder text itself is not a stable readiness affordance. The prompt glyph plus
    // the status footer emitted immediately below it is stable across startup, resume, and
    // an active turn. Requiring both avoids treating an old transcript line beginning with
    // `›` as proof that the current runtime finished booting.
    const lines = output.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!/^\s*(?:›|>)\s+\S/.test(lines[i] ?? "")) continue;
      const footerWindow = lines.slice(i + 1, i + 8).join("\n");
      if (/\bContext\s+\d+%\s+used\b/i.test(footerWindow)) return { state: "ready" as const };
      break;
    }
    return undefined;
  }
}
