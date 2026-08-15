import { shellQuote } from "../config/loadConfig.js";

export const PERSISTENT_INSTRUCTIONS_SOURCE_MAX_BYTES = 131_000;
const EXECVE_SINGLE_ARGUMENT_MAX_BYTES = 131_071;

export type PersistentInstructionsRuntime = "claude" | "codex" | "grok";

export function runtimeProjectsPersistentInstructions(runtime: string): runtime is PersistentInstructionsRuntime {
  return runtime === "claude" || runtime === "codex" || runtime === "grok";
}

export interface PersistentInstructionsLaunchInput {
  agent: string;
  runtime: string;
  instructions?: string;
  claudeFile?: string;
}

/** Exact launch option inserted before the ordinary positional startup brief. */
export function persistentInstructionsLaunchArgs(input: PersistentInstructionsLaunchInput): string[] {
  const text = input.instructions;
  if (!text?.trim() || !runtimeProjectsPersistentInstructions(input.runtime)) return [];

  const sourceBytes = Buffer.byteLength(text, "utf8");
  if (sourceBytes > PERSISTENT_INSTRUCTIONS_SOURCE_MAX_BYTES) {
    throw new Error(
      `agent '${input.agent}' ${input.runtime} persistent instructions are ${sourceBytes} UTF-8 bytes, ` +
        `above Tachyon's ${PERSISTENT_INSTRUCTIONS_SOURCE_MAX_BYTES}-byte measured launch ceiling; ` +
        "shorten the profile instructions (content was not truncated)",
    );
  }

  if (input.runtime === "claude") {
    if (!input.claudeFile) throw new Error(`agent '${input.agent}' Claude persistent-instructions file was not materialized`);
    return ["--append-system-prompt-file", shellQuote(input.claudeFile)];
  }
  if (input.runtime === "grok") return ["--rules", shellQuote(text)];

  // A JSON string is also a valid TOML basic string. Validate the exact execve argument after
  // escaping because quotes, newlines and control characters can expand beyond the source bytes.
  const override = `developer_instructions=${JSON.stringify(text)}`;
  const argumentBytes = Buffer.byteLength(override, "utf8");
  if (argumentBytes > EXECVE_SINGLE_ARGUMENT_MAX_BYTES) {
    throw new Error(
      `agent '${input.agent}' codex persistent instructions encode to ${argumentBytes} argument bytes, ` +
        `above the measured ${EXECVE_SINGLE_ARGUMENT_MAX_BYTES}-byte execve ceiling; ` +
        "shorten the profile instructions (content was not truncated)",
    );
  }
  return ["-c", shellQuote(override)];
}
