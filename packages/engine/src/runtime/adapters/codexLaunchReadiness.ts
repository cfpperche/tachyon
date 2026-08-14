import { MODEL_REJECTED_RE, type RuntimeLaunchReadinessAdapter } from "../launchReadiness.js";

export type CodexBootstrapPromptKind =
  | "terminal-warning"
  | "update-notice"
  | "directory-trust"
  | "hooks-overview"
  | "hook-review";

export interface CodexBootstrapInputMatch {
  kind: CodexBootstrapPromptKind;
  delivery: "submitted-line" | "literal-key";
}

const BOOTSTRAP_TAIL_LINES = 80;
const BOOTSTRAP_TAIL_CHARS = 32 * 1024;

function boundedTail(output: string): string {
  return output.slice(-BOOTSTRAP_TAIL_CHARS).split(/\r?\n/).slice(-BOOTSTRAP_TAIL_LINES).join("\n");
}

/**
 * Matches only measured Codex startup screens and their closed input grammars.
 * This is an authorization boundary for pre-ready pane input, not general
 * attention detection; broad prompt patterns must never be reused here.
 */
export function matchCodexBootstrapInput(output: string, text: string, submit: boolean): CodexBootstrapInputMatch | undefined {
  const tail = boundedTail(output);

  if (/\bWARNING:\s*TERM is set to ["']?dumb["']?[\s\S]{0,1200}\bContinue anyway\?\s*\[y\/N\]\s*:?\s*$/i.test(tail)) {
    return submit && /^(?:y|n)$/i.test(text) ? { kind: "terminal-warning", delivery: "submitted-line" } : undefined;
  }

  if (/\bUpdate available![\s\S]{0,1600}\b1\.\s*Update now\b[\s\S]{0,500}\b2\.\s*Skip\b[\s\S]{0,300}\b3\.\s*Skip until next version\b[\s\S]{0,400}\bPress enter to continue\b\s*$/i.test(tail)) {
    // Updating mutates the global CLI install, so pre-ready input can only defer it.
    return submit && /^(?:2|3)$/.test(text) ? { kind: "update-notice", delivery: "submitted-line" } : undefined;
  }

  if (/\bDo you trust the contents of this directory\?[\s\S]{0,1600}\b1\.\s*Yes, continue\b[\s\S]{0,400}\b2\.\s*No, quit\b[\s\S]{0,400}\bPress enter to continue\b\s*$/i.test(tail)) {
    return submit && /^(?:1|2)$/.test(text) ? { kind: "directory-trust", delivery: "submitted-line" } : undefined;
  }

  if (/\bHooks\b[\s\S]{0,2400}\bhooks? needs? review before (?:it|they) can run\b[\s\S]{0,1800}\bPress t to trust all; enter to review hooks; esc to close\b\s*$/i.test(tail)) {
    if (submit && text === "") return { kind: "hooks-overview", delivery: "submitted-line" };
    if (!submit && (text === "t" || text === "\u001b")) return { kind: "hooks-overview", delivery: "literal-key" };
    return undefined;
  }

  if (/\b(?:SessionStart|PreToolUse|PermissionRequest|PostToolUse|PreCompact|PostCompact|UserPromptSubmit|SubagentStart|SubagentStop|Stop) hooks\b[\s\S]{0,2400}\bPress t to trust; esc to go back\b\s*$/i.test(tail)) {
    return !submit && (text === "t" || text === "\u001b") ? { kind: "hook-review", delivery: "literal-key" } : undefined;
  }

  return undefined;
}

/** Classifies stable Codex terminal affordances only; it never retains pane text. */
export class CodexLaunchReadiness implements RuntimeLaunchReadinessAdapter {
  classify(output: string) {
    const lines = output.split(/\r?\n/).slice(-8);
    const liveOutput = lines.join("\n");
    // Rejection wins if a stale ready prompt remains visible above the terminal error.
    if (/\b(?:unauthorized|authentication (?:failed|required)|not logged in|api key (?:is )?(?:invalid|missing)|access denied)\b/i.test(liveOutput)) {
      return { state: "rejected" as const, code: "runtime_auth_rejected" as const };
    }
    if (MODEL_REJECTED_RE.test(liveOutput)) {
      return { state: "rejected" as const, code: "runtime_model_rejected" as const };
    }
    if (/\b(?:invalid (?:configuration|config)|configuration (?:error|failed)|failed to (?:load|parse) (?:configuration|config))\b/i.test(liveOutput)) {
      return { state: "rejected" as const, code: "runtime_config_rejected" as const };
    }
    if (/(?:^|\n)\s*(?:›|>)?\s*(?:Ask anything|Type a message)\b/i.test(liveOutput)) return { state: "ready" as const };

    // Codex rotates the composer placeholder (for example "Implement {feature}"), so the
    // placeholder text itself is not a stable readiness affordance. The prompt glyph plus
    // the status footer emitted immediately below it is stable across startup, resume, and
    // an active turn. Requiring both avoids treating an old transcript line beginning with
    // `›` as proof that the current runtime finished booting.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!/^\s*(?:›|>)\s+\S/.test(lines[i] ?? "")) continue;
      const footerWindow = lines.slice(i + 1, i + 8).join("\n");
      if (/\bContext\s+\d+%\s+used\b/i.test(footerWindow)) return { state: "ready" as const };
      // Narrow panes truncate the right side of the footer before Context. The left side remains
      // stable: model slug + reasoning effort/default + cwd, separated by middle dots.
      if (/^\s*[a-z0-9][a-z0-9._-]*\s+(?:minimal|low|medium|high|xhigh|default)\s+·\s+(?:[/~]|[a-z]:[\\/])\S*/im.test(footerWindow)) {
        return { state: "ready" as const };
      }
      break;
    }
    return undefined;
  }
}
