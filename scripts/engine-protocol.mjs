import { readFileSync } from "node:fs";

const DECLARATION =
  /^\s*export const ENGINE_SHELL_PROTOCOL = ([1-9][0-9]*) as const;\s*$/gm;

/**
 * Read the engine↔shell protocol from its TypeScript authority.
 *
 * The deliberately narrow declaration grammar makes a source refactor fail the build instead of
 * silently producing a manifest with a guessed or stale protocol. There must be exactly one match:
 * two declarations would merely move the split-brain problem into one file.
 */
export function parseEngineShellProtocol(source) {
  const matches = [...source.matchAll(DECLARATION)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "export const ENGINE_SHELL_PROTOCOL = <positive integer> as const;" declaration; found ${matches.length}`,
    );
  }
  const value = Number(matches[0][1]);
  if (!Number.isSafeInteger(value)) {
    throw new Error("ENGINE_SHELL_PROTOCOL must be a safe integer");
  }
  return value;
}

export function readEngineShellProtocol(file = "src/engine-service/protocol.ts") {
  return parseEngineShellProtocol(readFileSync(file, "utf8"));
}
