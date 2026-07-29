import { legacyFallbackUsed, type InstancePolicySource } from "./agentInstancePolicy.js";

/**
 * `t-fab832` — the activation gate for the Agent Instance cut, step 1.
 *
 * ## Why a gate instead of a migration
 *
 * The cut removes the canonical / ad-hoc / declared species outright: no dual-read, no grandfathering,
 * no alias layer. That choice makes migration code unnecessary and makes THIS necessary instead —
 * because state written by the old species can still be on disk, and a build that no longer
 * understands it must not silently reinterpret it. Refusing to activate is the honest answer: the
 * operator is told exactly what is in the way and how to clear it.
 *
 * The alternative — reading an old row "best effort" — is the failure this whole line of work exists
 * to end. A guess about what `declared: true` meant is still a guess after the species is gone.
 *
 * ## Three checks, kept separate on purpose
 *
 * They fail for different reasons and are cleared by different actions, so collapsing them into one
 * boolean would tell an operator that something is wrong without telling them what to do:
 *
 *  1. **Ledger rows** written before the instance policy existed. Cleared by ending those instances.
 *  2. **Roster entries** that are inline `agents:` definitions rather than canonical profile pointers.
 *     Cleared by editing config.
 *  3. **Live tmux sessions of agents this workspace owns.** Cleared by stopping them.
 *
 * ## What this NEVER does
 *
 * It never kills anything. A gate that cleaned up after itself would be making the very decision it
 * exists to escalate — and "activation killed my running fleet" is a worse outcome than any refusal.
 * It only reports, and names the governed action.
 */
export type LegacyOffenderKind = "ledger-row" | "roster-entry" | "live-agent-session";

export interface LegacyOffender {
  kind: LegacyOffenderKind;
  /** Agent name, which is what an operator acts on. */
  name: string;
  /** Why THIS entry is in the way, in the operator's terms. */
  detail: string;
}

export interface LegacyFleetGateResult {
  /** True when activation may proceed. False means: refuse, and show `offenders`. */
  ok: boolean;
  offenders: LegacyOffender[];
  /**
   * The governed action, per offender class present. Absent when `ok`. Never executed here — naming
   * the action IS the deliverable, because performing it is the operator's decision.
   */
  remedy?: string;
}

/** A roster entry as the gate sees it: name, what kind it is, and whether config points at a profile. */
export interface LegacyRosterEntry {
  name: string;
  kind: "agent" | "terminal";
  /** True when `agents.<name>` is a canonical profile pointer rather than an inline definition. */
  hasProfilePointer: boolean;
}

/** A live tmux session as the gate sees it. `session` is the raw tmux name, unparsed. */
export interface LegacySessionEntry {
  session: string;
  name: string;
  kind: "agent" | "terminal";
}

const SESSION_PREFIX = "tachyon";

/**
 * Does this tmux session belong to THIS workspace's Tachyon fleet?
 *
 * The prefix check is the negative control that matters most in practice: a developer's own
 * `tmux new -s notes` — or another workspace's Tachyon sessions — must never block activation here.
 * Tachyon owns exactly `tachyon-<wsHash>-*`, and anything else is somebody else's.
 */
export function isOwnedAgentSession(session: string, wsHash: string): boolean {
  return session.startsWith(`${SESSION_PREFIX}-${wsHash}-`);
}

const REMEDY: Record<LegacyOffenderKind, string> = {
  "ledger-row":
    "end those instances (Tachyon: Fleet → dismiss, or `dismiss_agent` for a stopped entry) so their ledger rows are released",
  "roster-entry":
    "convert or remove those `agents:` entries in tachyon.yml — an inline definition is the retired species; a canonical profile pointer is the supported shape",
  "live-agent-session":
    "stop those agents (Tachyon: Fleet → stop, or `kill_agent`) before activating this build",
};

/**
 * Inspect the workspace for state the retired species left behind.
 *
 * Pure by construction: every input is passed in, nothing is read or written here. That is what lets
 * the three seeds and the two negative controls be tested as facts rather than as a scenario.
 */
export function inspectLegacyFleet(input: {
  wsHash: string;
  /** Ledger rows, as `[name, row]`. A row without a declared instance policy predates the cut. */
  ledger: ReadonlyArray<readonly [string, InstancePolicySource]>;
  rosterEntries: readonly LegacyRosterEntry[];
  liveSessions: readonly LegacySessionEntry[];
}): LegacyFleetGateResult {
  const offenders: LegacyOffender[] = [];

  // 1. Ledger rows that predate the instance policy. `legacyFallbackUsed` already answers exactly
  //    this question — it was written under SDD 482 so the legacy path's removal could be an
  //    observation rather than a guess, and this is that observation being cashed in.
  for (const [name, row] of input.ledger) {
    if (!legacyFallbackUsed(row)) continue;
    offenders.push({
      kind: "ledger-row",
      name,
      detail: "session ledger row carries no instance policy — it was written before the Agent Instance cut",
    });
  }

  // 2. Inline roster definitions. TERMINALS ARE NOT CHECKED: `terminals:` is an explicit product
  //    surface with its own shape, it never carried the agent species, and blocking on one would be
  //    this gate reaching outside the thing it is gating.
  for (const entry of input.rosterEntries) {
    if (entry.kind !== "agent") continue;
    if (entry.hasProfilePointer) continue;
    offenders.push({
      kind: "roster-entry",
      name: entry.name,
      detail: "tachyon.yml declares this agent inline instead of pointing at a canonical profile",
    });
  }

  // 3. Live agent sessions THIS workspace owns that the new build cannot account for.
  //
  //    "LEGACY" IS DOING WORK IN THIS RULE, and getting it wrong is expensive: a live agent session
  //    is the NORMAL state of a running fleet, so refusing on every one of them would mean the
  //    product refuses to activate after any restart with agents up. What makes a session legacy is
  //    that it survived from a build before the cut — and the evidence for that is its ledger row:
  //    a session spawned by this build has a row carrying an instance policy. Absent or pre-cut row
  //    means nothing here can say what that process is, which is exactly the state to refuse.
  //
  //    Two negative controls live in the first two conditions: a product terminal is not an agent,
  //    and a session outside `tachyon-<wsHash>-` is not ours.
  //    FAIL-CLOSED, ratified: only a session PROVABLY spawned by this build admits. A pre-cut row
  //    refuses, and so does a MISSING row — "we have no record of this process" is not a reason to
  //    adopt it. The weaker reading I first shipped treated an absent row as absence of evidence; the
  //    ratified rule treats it as absence of PROOF, which is the direction a gate must fail.
  const provenPostCut = new Set(
    input.ledger.filter(([, row]) => !legacyFallbackUsed(row)).map(([name]) => name),
  );
  for (const entry of input.liveSessions) {
    if (entry.kind !== "agent") continue;
    if (!isOwnedAgentSession(entry.session, input.wsHash)) continue;
    if (provenPostCut.has(entry.name)) continue;
    offenders.push({
      kind: "live-agent-session",
      name: entry.name,
      detail: `tmux session ${entry.session} is a live agent with no post-cut ledger row to prove this build spawned it`,
    });
  }

  if (offenders.length === 0) return { ok: true, offenders: [] };

  // One remedy line per class PRESENT, in a stable order, so the message is about what is actually in
  // the way rather than a catalogue of everything that could ever be.
  const present: LegacyOffenderKind[] = (["live-agent-session", "ledger-row", "roster-entry"] as const)
    .filter((kind) => offenders.some((offender) => offender.kind === kind));
  return {
    ok: false,
    offenders,
    remedy: present.map((kind) => REMEDY[kind]).join("; then "),
  };
}

/** The refusal an operator reads. Separate from the inspection so the message is testable on its own. */
export function describeLegacyFleetRefusal(result: LegacyFleetGateResult): string {
  if (result.ok) return "";
  const byKind = new Map<LegacyOffenderKind, string[]>();
  for (const offender of result.offenders) {
    byKind.set(offender.kind, [...(byKind.get(offender.kind) ?? []), offender.name]);
  }
  const lines = [...byKind].map(([kind, names]) => `  ${kind}: ${names.sort().join(", ")}`);
  return [
    "Tachyon cannot activate this workspace: state from the retired agent species is still present.",
    "Nothing was changed or stopped — this build will not reinterpret it.",
    ...lines,
    `To proceed, ${result.remedy}.`,
  ].join("\n");
}
