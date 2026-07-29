/**
 * t-8354ae — fail-visible config failure state + degraded roster merge (pure).
 *
 * When tachyon.yml fails to load, the sidebar must never render as an empty fleet
 * if disk still knows agents (session ledger and/or last-known-good snapshot).
 * LKG is render-only: spawn/autostart must refuse LKG-derived definitions.
 */
import type { EntryKind } from "./loadConfig.js";
import type { ConfigLkgSnapshot } from "./configLkg.js";
import type { AgentInstanceLifetime, AgentInstancePolicy, SessionRecord } from "../resume/SessionLedger.js";
import { isResumable } from "../resume/SessionLedger.js";

/** Persistent config-error surface for the sidebar (and doctor). */
export interface ConfigFailure {
  /** absolute path of the failing config file */
  path: string;
  /** basename for short UI labels */
  file: string;
  errors: string[];
  at: string;
}

export interface ConfigErrorVM {
  file: string;
  path: string;
  errors: string[];
  /** first error, pre-truncated for the banner */
  summary: string;
}

export function toConfigErrorVM(failure: ConfigFailure): ConfigErrorVM {
  const first = failure.errors[0] ?? "invalid configuration";
  const more = failure.errors.length > 1 ? ` (+${failure.errors.length - 1} more)` : "";
  return {
    file: failure.file,
    path: failure.path,
    errors: failure.errors,
    summary: `${first}${more}`,
  };
}

/** A name that should appear in the degraded roster but may be missing from manager.list(). */
export interface DegradedRosterEntry {
  name: string;
  kind: EntryKind;
  /** from ledger when present; otherwise LKG */
  source: "ledger" | "lkg";
  /**
   * t-04052d — replaces `declared`, mirroring the live roster's field so the degraded view answers the
   * durability question the same way the healthy one does.
   */
  lifetime: AgentInstanceLifetime;
  /**
   * SDD 482 phase 3 — the declared instance policy, carried through from the ledger row so the
   * degraded roster asks the identity question the same way the live roster does. Absent for LKG
   * rows: the last-known-good CONFIG snapshot describes a Profile, not a recorded instance.
   */
  instance?: AgentInstancePolicy;
  cmd?: string;
  declaredOwner?: string;
  parent?: string;
  delegator?: string;
  worktreeBranch?: string;
  /** resume affordance only when ledger carries a resumable adapter row */
  resumable: boolean;
}

export interface DegradedRosterInput {
  /** names already present in the live manager list */
  existingNames: ReadonlySet<string>;
  ledger: ReadonlyArray<readonly [string, SessionRecord]>;
  lkg: ConfigLkgSnapshot | null;
}

/**
 * Names to ADD to the sidebar when config is invalid.
 * Priority: ledger (resume-capable) wins over LKG for the same name.
 * Existing live rows are never duplicated.
 */
export function degradedRosterExtras(input: DegradedRosterInput): DegradedRosterEntry[] {
  const out: DegradedRosterEntry[] = [];
  const seen = new Set(input.existingNames);

  for (const [name, rec] of input.ledger) {
    if (seen.has(name)) continue;
    seen.add(name);
    const kind: EntryKind = rec.def?.kind === "terminal" ? "terminal" : "agent";
    out.push({
      name,
      kind,
      source: "ledger",
      // Fail-closed, matching `isTemporaryInstance`: a row that declares no policy is not read as Saved.
      lifetime: rec.instance?.lifetime ?? "temporary",
      ...(rec.instance ? { instance: rec.instance } : {}),
      ...(rec.def?.cmd ? { cmd: rec.def.cmd } : {}),
      ...(rec.def?.parent ? { parent: rec.def.parent } : {}),
      ...(rec.def?.delegator ? { delegator: rec.def.delegator } : {}),
      ...(rec.worktree?.branch ? { worktreeBranch: rec.worktree.branch } : {}),
      resumable: isResumable(rec),
    });
  }

  for (const agent of input.lkg?.agents ?? []) {
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    out.push({
      name: agent.name,
      kind: agent.kind,
      source: "lkg",
      // An LKG entry IS a config-declared Profile — durable by construction, which is why it survived
      // into the last-known-good snapshot at all.
      lifetime: "saved",
      ...(agent.cmd ? { cmd: agent.cmd } : {}),
      ...(agent.declaredOwner ? { declaredOwner: agent.declaredOwner } : {}),
      resumable: false,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when a spawn/autostart would be drawing from LKG rather than a live valid config.
 * Callers pass whether the name is known via live config/adhoc (allowed) or only LKG (refused).
 */
export function isLkgOnlySpawn(opts: {
  configValid: boolean;
  nameInLiveConfigOrAdhoc: boolean;
  nameInLkg: boolean;
}): boolean {
  if (opts.configValid) return false;
  if (opts.nameInLiveConfigOrAdhoc) return false;
  return opts.nameInLkg;
}

export function lkgSpawnRefusalMessage(name: string, configFile: string): string {
  return (
    `cannot spawn '${name}': ${configFile} is invalid — last-known-good roster is render-only. ` +
    `Fix the config (Tachyon: Doctor) before starting agents that only exist in the LKG snapshot.`
  );
}
