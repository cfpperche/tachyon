import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { agentProfileSchemaV1 } from "./agentProfileSchema.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "./agentProfileReader.js";
import { CONFIG_FILENAMES } from "./loadConfig.js";

/**
 * SDD 482 phase 4 slice B (`t-5e1113`) — the ONE question the creation door asks about a proposer.
 *
 * Deliberately narrow. The door needs to know whether this agent was granted the authority to
 * propose; it does not need the agent's environment, its secrets references, its MCP list or its
 * prompt. Handing the Bridge a whole parsed profile so it can look at one boolean would be a wider
 * read than the question requires, and every extra field would then be one an accident could leak
 * into a proposal receipt.
 *
 * FAIL-CLOSED everywhere. No profile, unreadable profile, invalid YAML, schema mismatch, missing
 * `grants`, `false` — all the same answer: no. The only path to `true` is a profile that parses and
 * explicitly says so, which is what "absence refuses" has to mean when the file system is involved.
 */
export interface AgentProfileGrants {
  proposeSavedAgent?: boolean;
}

export function readAgentProfileGrants(workspaceRoot: string, agentName: string): AgentProfileGrants | undefined {
  let source: ReturnType<typeof readCanonicalAgentProfile>;
  try {
    source = readCanonicalAgentProfile(workspaceRoot, agentName);
  } catch {
    return undefined; // unreadable is not granted
  }
  if (!source) return undefined;
  try {
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) return undefined;
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) return undefined;
    return parsed.data.grants ?? {};
  } catch {
    return undefined;
  } finally {
    try { closeCanonicalAgentProfile(source); } catch { /* best effort */ }
  }
}

/**
 * SHA-256 of the workspace config, used as a proposal's BASE STATE.
 *
 * A proposal is computed against a roster; if that roster changes before a human approves, the thing
 * they were shown is no longer the thing that would be committed. Binding the digest to this value is
 * what makes that detectable instead of merely unlikely.
 *
 * A workspace with no config file yields the digest of the empty string rather than throwing — an
 * empty roster is a legitimate base state, and a proposal against it must still be invalidated if a
 * config appears in the meantime.
 */
export function workspaceConfigSha256(workspaceRoot: string): string {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(workspaceRoot, name);
    if (!fs.existsSync(file)) continue;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return crypto.createHash("sha256").update("").digest("hex");
}
