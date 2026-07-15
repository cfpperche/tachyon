import { containsUnsafeFramingCharacter } from "./framingSafety.js";

/** Parse a command into argv without invoking a shell. Supports whitespace separation, single/double
 * quotes, adjacent quoted fragments, and backslash escaping. Malformed input fails closed. */
export function parseArgvCommand(command: string): string[] {
  // The original text is also rendered into the agent primer. Reject framing/control bytes before
  // tokenization so a command that is safe for execFile cannot inject new primer lines or delimiters.
  if (containsUnsafeFramingCharacter(command)) {
    throw new Error("must not contain control characters");
  }
  const argv: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const push = (): void => {
    if (!tokenStarted) return;
    argv.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        tokenStarted = true;
      } else if (char === "\\" && quote === '"') {
        const next = command[++index];
        if (next === undefined) throw new Error("ends with an incomplete escape inside double quotes");
        current += next;
        tokenStarted = true;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined) throw new Error("ends with an incomplete escape");
      current += next;
      tokenStarted = true;
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (quote) throw new Error(`has an unclosed ${quote === "'" ? "single" : "double"} quote`);
  push();
  if (argv.length === 0 || argv[0]!.length === 0) throw new Error("must contain a non-empty executable argv[0]");
  return argv;
}
