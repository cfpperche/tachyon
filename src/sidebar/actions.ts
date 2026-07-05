import type { AgentVM } from "./types";

/**
 * spec 237 — the pure capability/action matrix (no vscode, no preact). Mirrors the tree's `when`-clause
 * gating (package.json view/item/context over agentContextValue): each agent offers ONLY the actions its
 * state + capabilities allow. The webview renders a curated PRIMARY subset inline + a "more" menu for the
 * rest. Unit-tested. Wiring these ids to real commands is the next increment.
 */
export type ActionId =
  | "activity" | "probes" | "inspect" | "stop" | "kill" | "restart" | "spawn" | "resume" | "fork" | "verify" | "reanchor" | "reinjectContinuity"
  | "promote" | "reviewWorktree" | "createPr" | "removeWorktree" | "edit" | "editYaml" | "clone" | "rename" | "remove";

export const ACTION_META: Record<ActionId, { icon: string; label: string }> = {
  activity: { icon: "pulse", label: "Activity" },
  probes: { icon: "beaker", label: "Probes" },
  inspect: { icon: "eye", label: "Open terminal" },
  stop: { icon: "primitive-square", label: "Stop graceful" },
  kill: { icon: "debug-disconnect", label: "Kill forced" },
  restart: { icon: "debug-restart", label: "Restart" },
  spawn: { icon: "play", label: "Start" },
  resume: { icon: "debug-continue", label: "Resume (with context)" },
  fork: { icon: "git-branch", label: "Fork session" },
  verify: { icon: "verified", label: "Verify" },
  reanchor: { icon: "compass", label: "Re-anchor to role" },
  reinjectContinuity: { icon: "history", label: "Re-inject continuity" },
  promote: { icon: "save", label: "Save to tachyon.yml" },
  reviewWorktree: { icon: "git-compare", label: "Review worktree changes" },
  createPr: { icon: "git-pull-request", label: "Create PR" },
  removeWorktree: { icon: "trash", label: "Remove worktree" },
  edit: { icon: "edit", label: "Edit in Studio" },
  editYaml: { icon: "file-code", label: "Edit YAML" },
  clone: { icon: "copy", label: "Clone" },
  rename: { icon: "pencil", label: "Rename" },
  remove: { icon: "trash", label: "Remove" },
};

const isRunning = (a: AgentVM) => a.status === "running" || a.status === "needs" || a.status === "throttled" || a.status === "idle";
/** Activity is a durable, per-agent history. It does not require a live tmux pane; a stopped AI row may still
 *  have useful log/context to inspect before the user decides between Resume and a fresh start. */
const canViewActivity = (a: AgentVM) => !!a.ai;
/** A tmux pane exists — live, crashed, or a clean-exit postmortem. Only a killed/never-started "stopped"
 *  row has no pane. Clean-exit postmortems are deliberately not user-facing terminals: the next meaningful
 *  actions are Activity, Resume, or Restart, not reopening a dead pane. */
const hasPane = (a: AgentVM) => a.pane ?? (a.status !== "stopped" || !!a.exited);
const isCleanExit = (a: AgentVM) => a.status === "stopped" && !!a.exited;
const isCleanExitPostmortem = (a: AgentVM) => isCleanExit(a) && hasPane(a);
const canRestart = (a: AgentVM) => !a.adhoc;
/** Resume (with saved context) replays an AI agent's transcript — offered for stopped|crashed (incl.
 *  clean-exit) when resumable. Terminals (ai:false) have no transcript, so never resume. */
const canResume = (a: AgentVM) => !!a.resumable && !!a.ai && (a.status === "stopped" || a.status === "crashed");

/** Every action available for an agent, gated by state + capability (the full set; "more" menu source). */
export function actionsFor(a: AgentVM): ActionId[] {
  const out: ActionId[] = [];
  if (canViewActivity(a)) out.push("activity");
  // spec 322 — probes are durable per-agent records like the activity log (same availability), but live in
  // the "…" menu only (never a primaryAction). An agent with zero probes gets an honest empty panel —
  // hiding the item behind data presence would be a discoverability trap (probe dueto F4).
  if (canViewActivity(a)) out.push("probes");
  if (a.status === "stopping") return [...out, "remove"];
  if (hasPane(a)) {
    if (!isCleanExitPostmortem(a)) out.push("inspect");
    if (isRunning(a)) out.push("stop", "kill");
    else out.push("kill");
    if (canRestart(a)) out.push("restart");
  } else if (isCleanExit(a) && canRestart(a)) out.push("restart");
  else out.push("spawn");
  if (canResume(a)) out.push("resume");
  if (a.forkable) out.push("fork");
  if (a.verifiable) out.push("verify");
  if (isRunning(a) && a.ai) out.push("reanchor", "reinjectContinuity");
  if (a.worktree) out.push("reviewWorktree", "createPr", "removeWorktree");
  if (a.adhoc) out.push("promote");
  out.push("edit", "editYaml", "clone", "rename");
  out.push("remove");
  return out;
}

/** The curated subset shown inline on the row (the rest live behind "more"). Keeps the overlay narrow.
 *  `kill` is intentionally never inline: it is destructive/forced and would otherwise replace the graceful
 *  Stop button after exit, moving the toolbar under the user's pointer. Keep it in the overflow menu only.
 *  NOTE: `fork` is deliberately NOT inline — it is a claude-only capability (`forkable`), so surfacing it on
 *  the row would make the quick-actions bar vary by runtime. Keeping it in the "more" menu standardizes the
 *  inline bar for every agent of any runtime (the runtime-asymmetric capability still lights up, just in ⋯). */
export function primaryActions(a: AgentVM): ActionId[] {
  const out: ActionId[] = [];
  if (canViewActivity(a)) out.push("activity");
  if (a.status === "stopping") return out;
  if (hasPane(a)) {
    if (!isCleanExitPostmortem(a)) out.push("inspect");
    if (isRunning(a)) out.push("stop");
    if (canRestart(a)) out.push("restart");
  } else if (isCleanExit(a) && canRestart(a)) out.push("restart");
  else out.push("spawn");
  if (canResume(a)) out.push("resume");
  if (a.verifiable) out.push("verify");
  return out.slice(0, 5);
}

/** Actions in the "more" overflow = everything available minus what's already shown inline. */
export function moreActions(a: AgentVM): ActionId[] {
  const inline = new Set(primaryActions(a));
  return actionsFor(a).filter((id) => !inline.has(id));
}
