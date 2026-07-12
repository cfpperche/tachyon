import { hasDeliveryMarker, isResumable, type SessionRecord } from "./SessionLedger.js";

/**
 * Pure activation-time resume decision (spec 209 / F29). Given the ledger and the
 * current world, classify each known agent. No fs, no vscode — Workspace executes
 * the plan (resume / notify) and the existing autostart loop fresh-spawns whatever
 * isn't resumed.
 *
 *   reattach    — session is alive (VS-Code-only crash); leave it (single-writer).
 *   auto-resume — session gone + declared with autostart → respawn with --resume.
 *   offer       — session gone + ad-hoc or declared-without-autostart → surface a
 *                 one-click resume, don't act unprompted.
 *
 * Agents NOT in the ledger are not our concern here — declared-autostart ones with
 * no session are fresh-spawned by the existing autostartPending path (which runs
 * AFTER auto-resume, so a just-resumed agent is already present and skipped).
 */

export type ResumeAction = "reattach" | "auto-resume" | "offer";

export interface ResumePlanItem {
  name: string;
  action: ResumeAction;
  record: SessionRecord;
}

export interface ResumeWorld {
  ledger: Map<string, SessionRecord>;
  /** Declared agent names whose def has autostart: true. */
  declaredAutostart: Set<string>;
  /** Agent names with a LIVE (non-dead) tmux session right now. */
  liveSessions: Set<string>;
  /**
   * SDD 368 T14 — agents denied by the read-only reload snapshot (including marker-less
   * cross-store crash rows). Generic plan must exclude them entirely.
   */
  deliveryUnavailableAgents?: ReadonlySet<string>;
  /**
   * SDD 368 T14/R3 — when explicitly false, no complete bounded reload snapshot is available
   * (store-read failure or pre-ready). Every generic plan action is denied. Omitted/undefined
   * preserves unit-test deny-set-only behavior; Workspace always passes a boolean after start.
   */
  deliveryReloadSnapshotReady?: boolean;
}

export function planResume(world: ResumeWorld): ResumePlanItem[] {
  const plan: ResumePlanItem[] = [];
  for (const [name, record] of world.ledger) {
    // spec 230 — pipeline-owned node sessions are reconciled by their PipelineManager run, never by
    // the generic resume/offer path (codex S4 M4). (autostartPending is already safe — it only
    // fresh-spawns DECLARED agents, and pipeline nodes are ad-hoc.)
    if (record.def?.pipeline) continue;
    // SDD 368 T14 — valid or invalid Delivery markers are never generic auto-resume/offer.
    // Reload may rehydrate definition/lineage for visibility; holder recovery is Delivery-owned.
    if (hasDeliveryMarker(record)) continue;
    // SDD 368 T14/R3 — fail-closed when Workspace reports snapshot not ready.
    if (world.deliveryReloadSnapshotReady === false) continue;
    // Marker-less crash window: snapshot deny set blocks ordinary rows that still map to
    // an unavailable Delivery holder (Delivery/projection durable, bindDelivery not yet written).
    if (world.deliveryUnavailableAgents?.has(name)) continue;
    if (world.liveSessions.has(name)) {
      plan.push({ name, action: "reattach", record });
    } else if (!isResumable(record)) {
      // Spec 211: a def-only row (e.g. an `sh` ad-hoc) has no conversation to
      // resume — never auto-resume nor offer it. It is still restartable via the
      // rehydrated def; that is a separate, non-resume path.
      continue;
    } else if (world.declaredAutostart.has(name)) {
      plan.push({ name, action: "auto-resume", record });
    } else {
      plan.push({ name, action: "offer", record });
    }
  }
  return plan;
}

export const autoResumes = (plan: ResumePlanItem[]): ResumePlanItem[] => plan.filter((p) => p.action === "auto-resume");
export const offers = (plan: ResumePlanItem[]): ResumePlanItem[] => plan.filter((p) => p.action === "offer");
