export const PREFLIGHT_MAX_OUTPUT_BYTES = 256 * 1024;
export const PREFLIGHT_TIMEOUT_MS = 3_000;
export const PREFLIGHT_MAX_SUGGESTIONS = 3;

export type RuntimeLaunchPreflight =
  | { state: "supported"; runtime: string; model?: string; source: string }
  | { state: "unsupported"; code: "runtime_model_unavailable"; runtime: string; model: string; suggestions: string[] }
  | { state: "unverifiable"; runtime?: string; reason: string }
  | { state: "failed"; code: "runtime_preflight_failed"; runtime?: string; reason: string };

export interface ParsedLaunchCommand {
  /** The resolved runtime executable, used for adapter selection. */
  binary: string;
  /** Arguments that would be passed to the resolved runtime executable. */
  argv: string[];
  /** The executable and fixed arguments used to probe the same launch path. */
  probeBinary: string;
  probeArgv: string[];
  model?: string;
}

export interface RuntimeLaunchPreflightPort {
  check(command: ParsedLaunchCommand, env: Readonly<Record<string, string | undefined>>): Promise<RuntimeLaunchPreflight>;
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
const ENV_OPERAND_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

export class RuntimeLaunchPreflightError extends Error {
  readonly code: "runtime_model_unavailable" | "runtime_preflight_failed";
  readonly model?: string;
  readonly suggestions: string[];

  constructor(result: Extract<RuntimeLaunchPreflight, { state: "unsupported" | "failed" }>) {
    const detail = result.state === "unsupported"
      ? `model '${result.model}' is unavailable${result.suggestions.length ? `; available close matches: ${result.suggestions.join(", ")}` : ""}`
      : result.reason;
    super(`${result.code}: ${detail}`);
    this.name = "RuntimeLaunchPreflightError";
    this.code = result.code;
    this.model = result.state === "unsupported" ? result.model : undefined;
    this.suggestions = result.state === "unsupported" ? result.suggestions : [];
  }
}

/** A deliberately small, non-executing shell tokenizer. Composition/substitution is ambiguous and rejected. */
export function parseLaunchCommand(input: string): ParsedLaunchCommand | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escaped) { token += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = undefined; else token += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (token) { tokens.push(token); token = ""; } continue; }
    if (";&|<>`".includes(ch) || (ch === "$" && input[i + 1] === "(")) return undefined;
    token += ch;
  }
  if (escaped || quote) return undefined;
  if (token) tokens.push(token);
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
  if (start >= tokens.length) return undefined;
  const probeStart = start;
  let base = tokens[start]!.split("/").pop() ?? "";
  // Match resolveBinary's launcher conventions, but retain the complete prefix so
  // `npx`/`env` probes observe the exact Codex selected by the delegated command.
  while (base === "env" || LAUNCHERS.has(base)) {
    start++;
    if (base === "env") {
      while (start < tokens.length) {
        const arg = tokens[start]!;
        if (ENV_OPERAND_FLAGS.has(arg)) { start += 2; continue; }
        if (arg.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { start++; continue; }
        break;
      }
    } else {
      while (start < tokens.length && (tokens[start]!.startsWith("-") || tokens[start]!.includes("="))) start++;
    }
    if (start >= tokens.length) return undefined;
    base = tokens[start]!.split("/").pop() ?? "";
  }
  const binary = tokens[start]!;
  const argv = tokens.slice(start + 1);
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-m" || arg === "--model") {
      if (!argv[i + 1] || argv[i + 1]!.startsWith("-")) return undefined;
      model = argv[++i];
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length) || undefined;
      if (!model) return undefined;
    }
  }
  return {
    binary,
    argv,
    probeBinary: tokens[probeStart]!,
    probeArgv: tokens.slice(probeStart + 1, start + 1),
    ...(model ? { model } : {}),
  };
}

/** Detect the narrow fail-closed case without attempting to interpret ambiguous shell syntax. */
export function isExplicitCodexModelCommand(input: string): boolean {
  // This is intentionally a conservative detector, not a shell parser. Once
  // composition made parsing ambiguous, any explicit Codex model is unverifiable.
  const tokens = input.replace(/(?:&&|\|\||[;&|<>`]|\$\()/g, " ").trim().split(/\s+/);
  let codex = -1;
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i]!.split("/").pop() ?? "") === "codex") { codex = i; break; }
  }
  return codex >= 0 && tokens.slice(codex + 1).some((arg) => arg === "-m" || arg === "--model" || arg.startsWith("--model="));
}

export function boundedCloseMatches(model: string, slugs: readonly string[]): string[] {
  const prefix = model.replace(/-[^-]+$/, "");
  return [...new Set(slugs)]
    .filter((slug) => slug !== model && (slug.startsWith(`${model}-`) || slug.startsWith(`${prefix}-`)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PREFLIGHT_MAX_SUGGESTIONS);
}
