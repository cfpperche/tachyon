import fs from "node:fs";
import { agentProfileHome } from "./agentProfileHome.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "./agentProfileReader.js";
import { isValidAgentName } from "./nameValidation.js";
import path from "node:path";

/**
 * t-ae221c — THE roster. `.tachyon/agents/<name>/` with a readable `agent.yml` is a fleet member,
 * and nothing else is.
 *
 * The `agents:` block in `tachyon.yml` used to be the source. It never carried information:
 * `agentProfilePointer.ts` accepted exactly one string per name —
 * `.tachyon/agents/<name>/agent.yml` — and refused every other, so the whole block was derivable
 * from the directory listing. What it did carry was a second durable copy of the same fact, which is
 * why create, rename and forget were two-file transactions with a failure class of their own
 * ("published the profile, did not write the pointer"). Reading the directory removes the copy, and
 * the class with it.
 *
 * ## Why the FILE decides membership, not the directory
 *
 * `agent.yml` is the definition. A directory without one is residue — an interrupted create, a
 * `forgetAgent` that took `evolution/`, profile data under a name nobody declared — and t-8b58b3
 * already named that state `orphan-home` and gave it a reason a human can act on. Making the
 * directory alone sufficient would turn every one of those into a phantom agent in the sidebar,
 * which is exactly what t-bbe760 had to close before this cut was safe to make.
 *
 * A member is therefore a name whose `agent.yml` can be READ. What is inside it is a different
 * question with a different answer: a profile that parses badly, has no host authority, or fails to
 * project is still a MEMBER and is reported as `refused` (t-0ad300), because an agent that vanishes
 * quietly is a worse failure than one that refuses loudly.
 */

export interface AgentRosterDirectoryEntry {
  agentName: string;
  /** Why this directory is not a member. Reported to the human; the STATE is derived by the sweep. */
  reason: string;
}

export interface AgentRosterDirectoryScan {
  /** Names with a readable `.tachyon/agents/<name>/agent.yml`, sorted. */
  members: string[];
  /** Directories that are not fleet members, sorted. Never an error: residue is a fact, not a failure. */
  nonMembers: AgentRosterDirectoryEntry[];
}

export function agentRosterDirectory(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agents");
}

/**
 * Enumerate the roster.
 *
 * Listing uses `Dirent.isDirectory()`, which is `lstat`-shaped: a symlink is neither listed as a
 * member nor reported as residue. That is the same rule `Workspace.savedAgentSubjects` and
 * `savedAgentPresenceFacts` already measure with, and a listing rule the measurement does not share
 * is how t-8b58b3 happened.
 *
 * An absent `.tachyon/agents/` is a workspace with no Saved Agents, not a failure — the same answer
 * an empty one gives.
 */
export function scanAgentRosterDirectory(workspaceRoot: string): AgentRosterDirectoryScan {
  const root = agentRosterDirectory(workspaceRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { members: [], nonMembers: [] };
  }
  const members: string[] = [];
  const nonMembers: AgentRosterDirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentName = entry.name;
    if (!isValidAgentName(agentName)) {
      nonMembers.push({ agentName, reason: "not a valid agent name" });
      continue;
    }
    let source: ReturnType<typeof readCanonicalAgentProfile>;
    try {
      source = readCanonicalAgentProfile(workspaceRoot, agentName);
    } catch (error) {
      // The bytes are there and cannot be trusted (too large, not a regular file, unreadable UTF-8,
      // an I/O refusal). Deliberately NOT a member and deliberately not an error either: the file is
      // still on disk, so `reconcile_roster` reports it as `unlisted-profile` and keeps its removal
      // in a human's hands.
      nonMembers.push({ agentName, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!source) {
      nonMembers.push({ agentName, reason: "no agent.yml" });
      continue;
    }
    closeCanonicalAgentProfile(source);
    members.push(agentName);
  }
  members.sort();
  nonMembers.sort((left, right) => (left.agentName < right.agentName ? -1 : left.agentName > right.agentName ? 1 : 0));
  return { members, nonMembers };
}

/** The warning a human reads for a directory under `.tachyon/agents/` that is not fleet. */
export function agentRosterDirectoryWarning(entry: AgentRosterDirectoryEntry): string {
  return `.tachyon/agents/${entry.agentName}/: ${entry.reason} — not a fleet member; `
    + "reconcile_roster names the state and the way to remove it";
}

/** True when this name has a canonical profile home on disk, whatever is or is not inside it. */
export function hasAgentProfileHome(workspaceRoot: string, agentName: string): boolean {
  return fs.lstatSync(agentProfileHome(workspaceRoot, agentName), { throwIfNoEntry: false })?.isDirectory() === true;
}
