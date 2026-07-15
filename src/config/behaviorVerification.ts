import path from "node:path";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";

export const BEHAVIOR_STUB_AGENT_TOKEN = "{agent}";
export const MAX_BEHAVIOR_TEST_BYTES = 2048;

/** Project-owned adapter for plain delegation behavior identifiers. */
export interface BehaviorVerificationSettings {
  adapter: "vitest-name";
  /** Argv prefix. The adapter appends: --run -t <behaviorTest> --reporter=json. */
  command: string;
  /** POSIX workspace-relative template for a pre-existing project-owned oracle; must contain {agent}. */
  stubPath: string;
  /** Tracked project files that define the verifier mechanics and must stay byte-identical. */
  executorPaths: string[];
}

export function behaviorTestError(value: string): string | undefined {
  if (!value.trim()) return "must be non-empty";
  if (Buffer.byteLength(value, "utf8") > MAX_BEHAVIOR_TEST_BYTES) {
    return `must be at most ${MAX_BEHAVIOR_TEST_BYTES} UTF-8 bytes`;
  }
  if (containsUnsafeFramingCharacter(value)) return "must not contain control characters";
  return undefined;
}

export function behaviorStubPathError(value: string): string | undefined {
  if (value.length === 0) return "must be non-empty";
  if (value !== value.trim()) return "must not have leading or trailing whitespace";
  if (Buffer.byteLength(value, "utf8") > 512) return "must be at most 512 UTF-8 bytes";
  if (containsUnsafeFramingCharacter(value)) return "must not contain control characters";
  if (value.includes("\\")) return "must use POSIX '/' separators, not backslashes";
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return "must be workspace-relative";
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) return "must not contain empty path segments";
  if (segments.some((segment) => segment === "." || segment === "..")) return "must not contain '.' or '..' segments";
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "must not address Git metadata";
  if (segments.some((segment) => /[<>:"|?*]/.test(segment))) {
    return "must not contain Windows-reserved or Git-pathspec characters";
  }
  if (segments.some((segment) => /[. ]$/.test(segment))) {
    return "must not contain segments ending in a dot or space";
  }
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    return "must not contain Windows device-name segments";
  }
  return undefined;
}

export function behaviorStubPathTemplateError(value: string): string | undefined {
  const relativeError = behaviorStubPathError(value);
  if (relativeError) return relativeError;
  if (!value.includes(BEHAVIOR_STUB_AGENT_TOKEN)) return `must contain ${BEHAVIOR_STUB_AGENT_TOKEN}`;
  return undefined;
}

export function configuredBehaviorStubPath(agent: string, template: string): string {
  const templateError = behaviorStubPathTemplateError(template);
  if (templateError) throw new Error(`settings.verify.behavior.stubPath ${templateError}`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(agent)) {
    throw new Error(`cannot render behavior stub path for invalid agent name '${agent}'`);
  }
  const rendered = template.replaceAll(BEHAVIOR_STUB_AGENT_TOKEN, agent);
  const renderedError = behaviorStubPathError(rendered);
  if (renderedError) {
    throw new Error(`settings.verify.behavior.stubPath renders an unsafe path for agent '${agent}': ${renderedError}`);
  }
  return rendered;
}
