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
  /** Exact source offset immediately after the runtime executable token. */
  runtimeTokenEnd: number;
  /** False when shell expansion could change any effective argv word. */
  allWordsLiteral: boolean;
  model?: string;
}

export interface RuntimeLaunchPreflightPort {
  check(command: ParsedLaunchCommand, env: Readonly<Record<string, string | undefined>>): Promise<RuntimeLaunchPreflight>;
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);

function separateOrLongEquals(tokens: string[], index: number, short: string | undefined, long: string): number | undefined {
  const arg = tokens[index]!;
  if ((short !== undefined && arg === short) || arg === long) {
    const operand = tokens[index + 1];
    return operand && !operand.startsWith("-") ? index + 2 : undefined;
  }
  if (arg.startsWith(`${long}=`)) return arg.length > long.length + 1 ? index + 1 : undefined;
  return undefined;
}

function envCommandIndex(tokens: string[], start: number): number | undefined {
  let index = start;
  while (index < tokens.length) {
    const arg = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || arg === "-i" || arg === "--ignore-environment") { index++; continue; }
    const next = [
      separateOrLongEquals(tokens, index, "-a", "--argv0"),
      separateOrLongEquals(tokens, index, "-C", "--chdir"),
      separateOrLongEquals(tokens, index, "-f", "--file"),
      separateOrLongEquals(tokens, index, "-u", "--unset"),
    ].find((candidate) => candidate !== undefined);
    if (next !== undefined) { index = next; continue; }
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
}

function npxCommandIndex(tokens: string[], start: number): number | undefined {
  let index = start;
  while (index < tokens.length) {
    const arg = tokens[index]!;
    if (["-y", "--yes", "--no", "--workspaces", "--include-workspace-root"].includes(arg)) { index++; continue; }
    if (arg === "--") return tokens[index + 1] && !tokens[index + 1]!.startsWith("-") ? index + 1 : undefined;
    const next = [
      separateOrLongEquals(tokens, index, "-p", "--package"),
      separateOrLongEquals(tokens, index, "-w", "--workspace"),
    ].find((candidate) => candidate !== undefined);
    if (next !== undefined) { index = next; continue; }
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
}

function pnpxCommandIndex(tokens: string[], start: number): number | undefined {
  let index = start;
  while (index < tokens.length) {
    const arg = tokens[index]!;
    if (arg === "--allow-build") { index++; continue; }
    const next = [
      separateOrLongEquals(tokens, index, undefined, "--package"),
      separateOrLongEquals(tokens, index, undefined, "--reporter"),
    ].find((candidate) => candidate !== undefined);
    if (next !== undefined) { index = next; continue; }
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
}

function bunxCommandIndex(tokens: string[], start: number): number | undefined {
  let index = start;
  while (index < tokens.length) {
    const arg = tokens[index]!;
    if (["--bun", "--no-install", "--verbose", "--silent"].includes(arg)) { index++; continue; }
    const next = separateOrLongEquals(tokens, index, "-p", "--package");
    if (next !== undefined) { index = next; continue; }
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
}

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
  const tokenEnds: number[] = [];
  const literalWords: boolean[] = [];
  let token = "";
  let tokenStarted = false;
  let tokenLiteral = true;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const pushToken = (end: number) => {
    if (!tokenStarted) return;
    tokens.push(token); tokenEnds.push(end); literalWords.push(tokenLiteral);
    token = ""; tokenStarted = false; tokenLiteral = true;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escaped) { tokenStarted = true; token += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { tokenStarted = true; escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = undefined;
      else {
        if (quote === '"' && (ch === "`" || (ch === "$" && input[i + 1] === "("))) return undefined;
        if (quote === '"' && ch === "$") tokenLiteral = false;
        tokenStarted = true; token += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { tokenStarted = true; quote = ch; continue; }
    if (ch === "\n" || ch === "\r") return undefined;
    if (/\s/.test(ch)) { pushToken(i); continue; }
    if (";&|<>`()!#".includes(ch) || (ch === "$" && input[i + 1] === "(")) return undefined;
    if (ch === "$" || "*?[~{}".includes(ch)) tokenLiteral = false;
    tokenStarted = true;
    token += ch;
  }
  if (escaped || quote) return undefined;
  pushToken(input.length);
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
  if (start >= tokens.length) return undefined;
  const probeStart = start;
  let base = tokens[start]!.split("/").pop() ?? "";
  // Explicit wrapper grammar only: env may wrap one measured package launcher, which then yields
  // exactly one runtime token. Unknown, shell-evaluating, or missing-operand forms fail closed.
  if (base === "env") {
    const command = envCommandIndex(tokens, start + 1);
    if (command === undefined) return undefined;
    start = command; base = tokens[start]!.split("/").pop() ?? "";
  }
  if (LAUNCHERS.has(base)) {
    const command = base === "npx" ? npxCommandIndex(tokens, start + 1)
      : base === "pnpx" ? pnpxCommandIndex(tokens, start + 1)
        : bunxCommandIndex(tokens, start + 1);
    if (command === undefined) return undefined;
    start = command; base = tokens[start]!.split("/").pop() ?? "";
    if (base === "env" || LAUNCHERS.has(base)) return undefined;
  }
  const binary = tokens[start]!;
  const runtimeTokenEnd = tokenEnds[start]!;
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
    runtimeTokenEnd,
    allWordsLiteral: literalWords.every(Boolean),
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
