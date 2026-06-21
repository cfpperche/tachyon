import type { ContinuityStatus } from "./ContinuityStore.js";

/**
 * spec 241 D3/D9 — the PURE decision for "should Tachyon re-inject the continuity pointer now?".
 * Kept vscode-free + node-testable (the spec-240 configHome drift class of bugs lived in vscode-bound code
 * that CI never ran). The engine wiring only collects the inputs and performs the side effects.
 *
 * The central correction from the debate: a same-session RESUME is NOT automatically safe — if a compaction
 * (or `/clear` / session change) happened since the last restore, the resumed model holds only the lossy
 * summary and DOES need its continuity back. So we key on `discontinuitySinceRestore`, not "is it a resume".
 */

export type Transition =
  | "restart" // Tachyon restart → a brand-new session lost everything
  | "resume" // Tachyon resume → re-attach an existing session (safe ONLY if no discontinuity since restore)
  | "new-session" // session id changed outside our control (`/clear`, user-started session)
  | "compaction-idle" // a compaction was detected and the agent went idle
  | "manual"; // human asked (Re-inject continuity) — always honor

export type InjectReason = "restart" | "post-compaction-resume" | "new-session" | "compaction" | "manual" | "cold-start" | "none";

export interface InjectionInput {
  transition: Transition;
  /** a continuity brief exists for this agent */
  hasBrief: boolean;
  /** a compaction / `/clear` / session change occurred since the last continuity restore (D9 state) */
  discontinuitySinceRestore: boolean;
  /** the brief's status — a `done` brief is never injected as active work (D4) */
  briefStatus?: ContinuityStatus;
}

export interface InjectDecision {
  inject: boolean;
  reason: InjectReason;
}

/** Decide whether to re-inject the continuity pointer for a transition. Pure. */
export function classifyInjection(i: InjectionInput): InjectDecision {
  // A finished brief is never re-injected as active work (manual still wins — the human asked).
  if (i.briefStatus === "done" && i.transition !== "manual") return { inject: false, reason: "none" };

  // Cold start: no brief yet. On a real discontinuity (or manual), nudge the agent to create one; otherwise stay quiet.
  if (!i.hasBrief) {
    const wantsNudge = i.transition === "manual" || i.transition === "restart" || i.transition === "new-session" || i.transition === "compaction-idle" || (i.transition === "resume" && i.discontinuitySinceRestore);
    return wantsNudge ? { inject: true, reason: "cold-start" } : { inject: false, reason: "none" };
  }

  switch (i.transition) {
    case "manual":
      return { inject: true, reason: "manual" };
    case "restart":
      return { inject: true, reason: "restart" };
    case "new-session":
      return { inject: true, reason: "new-session" };
    case "compaction-idle":
      return { inject: true, reason: "compaction" };
    case "resume":
      // The D3 fix: inject a resume ONLY when the context is actually at risk (a discontinuity since the last
      // restore). A clean same-session resume keeps the model's context → injecting would double-context it.
      return i.discontinuitySinceRestore ? { inject: true, reason: "post-compaction-resume" } : { inject: false, reason: "none" };
  }
}

export interface InjectionTextInput {
  agent: string;
  reason: InjectReason;
  /** exact activity-seq lag (D4); undefined when unknown */
  lag?: number;
  /** the staleness threshold past which the brief is flagged "may be stale" (D4) */
  staleLag?: number;
  briefStatus?: ContinuityStatus;
}

/**
 * The exact text typed into the pane (D5 — the only thing that goes to the pane; the badge is the quiet
 * channel). Pure so the wording is unit-tested. States the EXACT lag and a stale caveat (D4); never claims
 * the brief is correct — the activity log is the source of truth.
 */
export function injectionText(i: InjectionTextInput): string {
  const role = `cat .tachyon/roles/${i.agent}.md`;
  const cont = `cat .tachyon/continuity/${i.agent}.md`;
  if (i.reason === "cold-start") {
    return ["[Tachyon] No continuity brief yet. Read your role, then checkpoint your working state once your goal/current state are clear:", `  ${role}`, "  → then set_continuity (Current Goal · Working State · Next Steps · Open Threads)"].join("\n");
  }
  const stale = i.lag !== undefined && i.staleLag !== undefined && i.lag > i.staleLag;
  const lagNote = i.lag !== undefined ? ` (brief is ${i.lag} activity records behind${stale ? " — MAY BE STALE; reconcile with recent activity" : ""})` : "";
  const pausedNote = i.briefStatus === "paused" ? " [status: paused — re-scope before treating as active]" : "";
  return ["[Tachyon] Continuity available — rebuild your working context before continuing:" + lagNote + pausedNote, `  ${role}`, `  ${cont}`].join("\n");
}

/**
 * spec 241 OQ1 — the PROACTIVE checkpoint reminder (distinct from re-injection): when an active brief has
 * fallen `lag` records behind while the agent is idle, nudge it to checkpoint NOW (while context is still
 * rich), so a future compaction has a fresh brief to restore. Quiet-channel cooldown is enforced by the caller.
 */
export function reminderText(lag: number): string {
  return `[Tachyon] Your continuity brief is ${lag} activity records behind — checkpoint your current state with set_continuity so it survives the next compaction / clear.`;
}

/**
 * spec 241 OQ3 — the COLD-START proactive nudge: an agent that has done real work but never checkpointed gets
 * reminded to create its first continuity brief (so the FIRST compaction doesn't catch it empty). Cooldowned by
 * the caller; fires during normal idle work, not only on a discontinuity.
 */
export function coldStartReminderText(): string {
  return "[Tachyon] You have no continuity brief yet — checkpoint your working state with set_continuity (Current Goal · Next Steps · Open Threads) so it survives a compaction / clear / restart.";
}

