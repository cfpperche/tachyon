export type PromptAdapter = {
  runtime: string;
  channel: "startup-argument" | "tui-prefill" | "native-external";
  compose?: (quotedPrompt: string) => string;
};

const PROMPT_ADAPTERS: Readonly<Record<string, PromptAdapter>> = Object.freeze({
  claude: { runtime: "claude", channel: "startup-argument", compose: (prompt) => prompt },
  codex: { runtime: "codex", channel: "startup-argument", compose: (prompt) => prompt },
  agy: { runtime: "agy", channel: "startup-argument", compose: (prompt) => `--prompt-interactive ${prompt}` },
  gemini: { runtime: "gemini", channel: "startup-argument", compose: (prompt) => `-i ${prompt}` },
  opencode: { runtime: "opencode", channel: "tui-prefill", compose: (prompt) => `--prompt ${prompt}` },
  grok: { runtime: "grok", channel: "startup-argument", compose: (prompt) => prompt },
  hermes: { runtime: "hermes", channel: "native-external" },
});

/** Shared syntactic classification, including env flags whose following token is an operand. */
export function resolveRuntimeBinary(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const basename = (token: string | undefined) => (token ?? "").split("/").pop() ?? "";
  const launcher = basename(tokens[0]);
  if (launcher === "npx" || launcher === "bunx" || launcher === "pnpx") {
    return basename(tokens.slice(1).find((token) => !token.startsWith("-") && !token.includes("=")));
  }
  if (launcher !== "env") return launcher;
  const operandFlags = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (operandFlags.has(token)) { index += 2; continue; }
    if (token.startsWith("-") || token.includes("=")) { index++; continue; }
    break;
  }
  return basename(tokens[index]);
}

export function runtimePromptAdapter(command: string): PromptAdapter | undefined {
  return PROMPT_ADAPTERS[resolveRuntimeBinary(command)];
}
