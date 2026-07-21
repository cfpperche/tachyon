/**
 * SDD 420 — layered safety for user_browser_* mutations (headless-testable core).
 */

import fs from "node:fs";
import path from "node:path";

export type DangerousClass =
  | "publish"
  | "form_submit"
  | "buy"
  | "delete"
  | "download"
  | "none";

export type SafetyDecision =
  | { allow: true }
  | { allow: false; code: "needs_confirm" | "restricted"; message: string };

/** Classify intent from tool + optional selector/ref/url (heuristic layer). */
export function classifyDangerousAction(input: {
  tool: string;
  selector?: string;
  ref?: string;
  text?: string;
  url?: string;
  submit?: boolean;
}): DangerousClass {
  if (input.submit === true) return "form_submit";
  const blob = `${input.selector ?? ""} ${input.ref ?? ""} ${input.text ?? ""} ${input.url ?? ""}`.toLowerCase();
  if (/\b(delete|remove|destroy|excluir|apagar)\b/.test(blob)) return "delete";
  if (/\b(buy|purchase|checkout|pay|comprar|pagamento)\b/.test(blob)) return "buy";
  if (/\b(download|export|baixar)\b/.test(blob)) return "download";
  if (/\b(publish|post|submit|enviar|publicar)\b/.test(blob)) return "publish";
  if (input.tool === "user_browser_type" || input.tool === "user_browser_fill") {
    // typing alone is not auto-submit unless submit flag
    return "none";
  }
  return "none";
}

/**
 * Domain allowlist: empty/undefined = all hosts (still subject to confirm).
 * Missing url is not a deny — act tools often lack a URL until the extension
 * resolves the tab; only explicit known URLs are filtered (goto / tab_open).
 */
export function hostAllowed(url: string | undefined, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  if (!url) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((pat) => {
    const p = pat.toLowerCase().trim();
    if (!p) return false;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // .example.com
      return host.endsWith(suffix) || host === p.slice(2);
    }
    return host === p;
  });
}

/**
 * Layered gate: domain first, then dangerous class → needs_confirm
 * (human resolution is host-side approvals later; tools fail closed until confirmed).
 */
export function evaluateMutationSafety(input: {
  tool: string;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  submit?: boolean;
  allowedHosts?: string[];
  /** When true, skip needs_confirm (used after explicit host approval path). */
  confirmed?: boolean;
}): SafetyDecision {
  if (!hostAllowed(input.url, input.allowedHosts)) {
    return {
      allow: false,
      code: "restricted",
      message: `Host not in settings.companion.allowedHosts (url=${input.url ?? "unknown"}).`,
    };
  }
  const cls = classifyDangerousAction(input);
  if (cls !== "none" && !input.confirmed) {
    return {
      allow: false,
      code: "needs_confirm",
      message: `Action class '${cls}' requires human confirmation before apply (SDD 420).`,
    };
  }
  return { allow: true };
}

/** Redact password-like fields from free-form strings. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(password|passwd|pwd)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/bearer\s+[a-z0-9._\-]+/gi, "bearer [redacted]")
    .replace(/cookie\s*[:=]\s*\S+/gi, "cookie=[redacted]");
}

export interface MutationLogEntry {
  at: string;
  tool: string;
  tabId?: string;
  url?: string;
  status: string;
  code?: string;
  detail?: string;
}

/** Append-only redacted mutation log under workspace .tachyon/companion/mutations.jsonl */
export function appendMutationLog(workspaceRoot: string, entry: MutationLogEntry): void {
  try {
    const dir = path.join(workspaceRoot, ".tachyon", "companion");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "mutations.jsonl");
    const line =
      JSON.stringify({
        ...entry,
        detail: entry.detail ? redactSecrets(entry.detail) : undefined,
      }) + "\n";
    fs.appendFileSync(file, line, { mode: 0o600 });
    // Ensure .gitignore
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) {
      fs.writeFileSync(gi, "mutations.jsonl\nscreenshots/\n", "utf8");
    }
  } catch {
    /* best-effort audit */
  }
}
