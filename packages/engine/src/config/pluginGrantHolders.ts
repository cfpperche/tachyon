import { parseDocument } from "yaml";
import { agentProfileSchemaV1 } from "./agentProfileSchema.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "./agentProfileReader.js";
import { scanAgentRosterDirectory } from "./agentRosterDirectory.js";

/**
 * t-b1940c — who holds a grant on a plugin, read from the roster the delivery itself reads.
 *
 * `applyRemove` tears the payload out of `.tachyon/plugins/<name>` and nothing else, so the
 * references an authorization wrote survive pointing at a directory that no longer exists. Naming
 * the agents that lose what — option (b) — needs this enumeration BEFORE anything can be revoked,
 * and it must use the SAME membership rule delivery uses: a member is a name whose `agent.yml` can
 * be read (`scanAgentRosterDirectory`), never a directory that happens to exist.
 *
 * Deliberately narrow like `readAgentProfileGrants` beside it: the caller needs agent × referenceId
 * pairs, not whole profiles. A profile that parses badly is SKIPPED rather than fatal — the revoke
 * loop reports what it could not clean, and one broken profile must not hide the others.
 */
export interface PluginGrantHolder {
  agent: string;
  referenceId: string;
}

/**
 * t-b1940c — what a plugin-removal revocation DID, per agent. `errors` carries the refusals and
 * broken transactions per holder: option (b) is "say who lost what", and a silent skip would make
 * that sentence a lie. `running` is t-746f0f's duty said at the moment of the gesture: an agent
 * that was live keeps its launched copy of the skill until its next launch, and the caller must be
 * able to say so instead of implying the capability vanished under the session. A report with
 * neither list populated means no profile ever held a grant.
 */
export interface PluginGrantsRevocationReport {
  schemaVersion: 1;
  revoked: Array<{ agent: string; referenceId: string; deselected: boolean; running: boolean }>;
  errors: Array<{ agent: string; referenceId: string; error: string }>;
}

export function pluginGrantHolders(workspaceRoot: string, pluginName: string): PluginGrantHolder[] {
  const owner = `plugin:${pluginName}`;
  const holders: PluginGrantHolder[] = [];
  for (const agent of scanAgentRosterDirectory(workspaceRoot).members) {
    let source: ReturnType<typeof readCanonicalAgentProfile>;
    try {
      source = readCanonicalAgentProfile(workspaceRoot, agent);
    } catch {
      continue; // unreadable bytes are the roster scanner's residue to report, not ours to fail on
    }
    if (!source) continue;
    try {
      const doc = parseDocument(source.text, { uniqueKeys: true });
      if (doc.errors.length > 0) continue;
      const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
      if (!parsed.success) continue;
      for (const reference of parsed.data.references ?? []) {
        // Skill references only: `authorizeAgentPlugin` grants skills, and the service-level
        // revoke below moves exactly that shape. Other kinds owned by a plugin have no grant to
        // revoke through this door.
        if (reference.kind === "skill" && reference.owner === owner) {
          holders.push({ agent, referenceId: reference.id });
        }
      }
    } catch {
      continue;
    } finally {
      try { closeCanonicalAgentProfile(source); } catch { /* best effort */ }
    }
  }
  return holders;
}
