import { isAlias, isMap, isScalar, parseDocument, type Pair, type Scalar, type YAMLMap } from "yaml";
import { isValidAgentName } from "./nameValidation.js";

export const AGENT_PROFILE_POINTER_KEY = "profile" as const;

export interface AgentProfilePointer {
  agentName: string;
  path: string;
  source: string;
}

export interface AgentProfilePointerScan {
  pointers: Map<string, AgentProfilePointer>;
  errors: string[];
}

export function canonicalAgentProfilePointer(agentName: string): string {
  return `.tachyon/agents/${agentName}/agent.yml`;
}

function scalarText(node: unknown): string | undefined {
  return isScalar(node) && typeof (node as Scalar).value === "string"
    ? String((node as Scalar).value)
    : undefined;
}

function pairKey(pair: Pair): string | undefined {
  return scalarText(pair.key);
}

/**
 * Synchronous syntax-only scan. Filesystem reads, profile authority and runtime
 * inspection deliberately belong to the second loading phase.
 */
export function scanAgentProfilePointers(yamlText: string): AgentProfilePointerScan {
  const doc = parseDocument(yamlText, { uniqueKeys: true });
  const errors = doc.errors.map((error) => `invalid YAML: ${error.message}`);
  const pointers = new Map<string, AgentProfilePointer>();
  if (errors.length > 0) return { pointers, errors };

  const agents = doc.get("agents", true);
  if (agents === undefined || agents === null) return { pointers, errors };
  if (!isMap(agents)) return { pointers, errors };

  for (const entry of (agents as YAMLMap).items) {
    const agentName = pairKey(entry);
    if (!agentName || !isValidAgentName(agentName)) continue;
    const stanza = entry.value;
    if (isAlias(stanza)) {
      errors.push(`agents.${agentName}: aliases are not allowed for an agent profile pointer`);
      continue;
    }
    if (!isMap(stanza)) continue;
    const profilePairs = stanza.items.filter((pair) => pairKey(pair) === AGENT_PROFILE_POINTER_KEY);
    if (profilePairs.length === 0) continue;
    if (profilePairs.length !== 1) {
      errors.push(`agents.${agentName}.profile: duplicate profile key`);
      continue;
    }
    const keys = stanza.items.map(pairKey);
    if (keys.some((key) => key === undefined)) {
      errors.push(`agents.${agentName}: profile stanza keys must be plain strings`);
      continue;
    }
    if (keys.length !== 1) {
      const inline = keys.filter((key) => key !== AGENT_PROFILE_POINTER_KEY).join(", ");
      errors.push(`agents.${agentName}: profile pointer cannot coexist with inline field(s): ${inline}`);
      continue;
    }
    const value = scalarText(profilePairs[0]!.value);
    const expected = canonicalAgentProfilePointer(agentName);
    if (value === undefined) {
      errors.push(`agents.${agentName}.profile: must be the exact conventional profile path ${JSON.stringify(expected)}`);
      continue;
    }
    if (value !== expected) {
      errors.push(`agents.${agentName}.profile: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      continue;
    }
    pointers.set(agentName, {
      agentName,
      path: value,
      source: `tachyon.yml#agents.${agentName}.profile`,
    });
  }
  return { pointers, errors };
}
