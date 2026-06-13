import { isResumable, type SessionRecord } from "./SessionLedger.js";

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
}

export function planResume(world: ResumeWorld): ResumePlanItem[] {
  const plan: ResumePlanItem[] = [];
  for (const [name, record] of world.ledger) {
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
