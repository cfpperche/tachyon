import { isAgentRow, type AgentVM } from "./types";

/**
 * spec 237 — the pure capability/action matrix (no vscode, no preact). Mirrors the tree's `when`-clause
 * gating (package.json view/item/context over agentContextValue): each agent offers ONLY the actions its
 * state + capabilities allow. The webview renders a curated PRIMARY subset inline + a "more" menu for the
 * rest. Unit-tested. Wiring these ids to real commands is the next increment.
 */
export type ActionId =
  | "activity" | "probes" | "inspect" | "openPane" | "stop" | "kill"
  | "restart" | "restartNew" | "restartForceNew"
  | "spawn" | "resume" | "fork" | "verify" | "reanchor" | "reinjectContinuity" | "injectPrompt"
  // t-4662e9 — no `rename`. Renaming a canonical agent is the Agent Form's operation (it carries the
  // profile lifecycle: authority re-signing, digest, retirement of the old name). The sidebar's action
  // called a different one, `config.agent.rename`, which only rewrites the tachyon.yml entry — a second,
  // divergent surface for the same word. It was also pushed unconditionally, so an Temporary row offered a
  // rename for an entity that does not exist to be renamed.
  | "promote" | "reviewWorktree" | "createPr" | "removeWorktree" | "edit" | "editYaml" | "clone" | "remove";

export const ACTION_META: Record<ActionId, { icon: string; label: string }> = {
  activity: { icon: "pulse", label: "Activity" },
  probes: { icon: "beaker", label: "Probes" },
  inspect: { icon: "eye", label: "Open terminal" },
  // t-610355 — layer-2 first-party pane (webview+xterm); sits next to integrated-terminal open
  openPane: { icon: "terminal", label: "Open agent pane" },
  stop: { icon: "primitive-square", label: "Stop graceful" },
  kill: { icon: "debug-disconnect", label: "Kill forced" },
  // spec 389 — one-click default (graceful+resume); variants live next to it in ⋯, no VS Code QuickPick.
  restart: { icon: "debug-restart", label: "Restart" },
  restartNew: { icon: "debug-restart", label: "Restart new section" },
  restartForceNew: { icon: "debug-disconnect", label: "Force restart (new section)" },
  spawn: { icon: "play", label: "Start" },
  resume: { icon: "debug-continue", label: "Resume (with context)" },
  fork: { icon: "git-branch", label: "Fork session" },
  verify: { icon: "verified", label: "Verify" },
  reanchor: { icon: "compass", label: "Re-anchor to role" },
  reinjectContinuity: { icon: "history", label: "Re-inject continuity" },
  injectPrompt: { icon: "symbol-snippet", label: "Inject prompt template" },
  promote: { icon: "save", label: "Save to tachyon.yml" },
  reviewWorktree: { icon: "git-compare", label: "Review worktree changes" },
  createPr: { icon: "git-pull-request", label: "Create PR" },
  removeWorktree: { icon: "trash", label: "Remove worktree" },
  edit: { icon: "edit", label: "Edit in Studio" },
  editYaml: { icon: "file-code", label: "Edit YAML" },
  clone: { icon: "copy", label: "Clone" },
  remove: { icon: "trash", label: "Remove" },
};

const isRunning = (a: AgentVM) =>
  a.status === "running" || a.status === "needs" || a.status === "throttled" || a.status === "done" || a.status === "idle" || a.status === "stop-failed";
/** Activity is a durable, per-agent history. It does not require a live tmux pane; a stopped AI row may still
 *  have useful log/context to inspect before the user decides between Resume and a fresh start. */
const canViewActivity = (a: AgentVM) => isAgentRow(a);
/** A tmux pane exists — live, crashed, or a clean-exit postmortem. Only a killed/never-started "stopped"
 *  row has no pane. Clean-exit postmortems are deliberately not user-facing terminals: the next meaningful
 *  actions are Activity, Resume, or Restart, not reopening a dead pane. */
const hasPane = (a: AgentVM) => a.pane ?? (a.status !== "stopped" || !!a.exited);
const isCleanExit = (a: AgentVM) => a.status === "stopped" && !!a.exited;
const isCleanExitPostmortem = (a: AgentVM) => isCleanExit(a) && hasPane(a);
const canRestart = (_a: AgentVM) => true;
/** Resume (with saved context) replays an AI agent's transcript — offered for stopped|crashed (incl.
 *  clean-exit) when resumable. Terminals have no transcript, so they never resume. */
const canResume = (a: AgentVM) => !!a.resumable && isAgentRow(a) && (a.status === "stopped" || a.status === "crashed");

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
    if (!isCleanExitPostmortem(a)) out.push("inspect", "openPane");
    if (isRunning(a)) out.push("stop", "kill");
    else out.push("kill");
    if (canRestart(a)) out.push("restart", "restartNew", "restartForceNew");
  } else if (isCleanExit(a) && canRestart(a)) out.push("restart", "restartNew", "restartForceNew");
  else out.push("spawn");
  if (canResume(a)) out.push("resume");
  if (a.forkable) out.push("fork");
  if (a.verifiable) out.push("verify");
  // spec 381 — injectPrompt joins reanchor/reinject as mid-session operator ops on live AI panes
  if (isRunning(a) && isAgentRow(a)) out.push("reanchor", "reinjectContinuity", "injectPrompt");
  if (a.worktree) out.push("reviewWorktree", "createPr", "removeWorktree");
  if (a.adhoc) out.push("promote");
  if (!a.adhoc) out.push("edit", "editYaml", "clone");
  out.push("remove");
  return out;
}

/** The curated subset shown inline on the row (the rest live behind "more"). Keep one-click actions to
 *  read-only surfaces only: durable Activity and the raw terminal/output view (integrated + first-party pane).
 *  Lifecycle/destructive actions (start/stop/restart/resume/kill/remove) need the deliberate extra click
 *  through the overflow menu. */
export function primaryActions(a: AgentVM): ActionId[] {
  const out: ActionId[] = [];
  if (canViewActivity(a)) out.push("activity");
  if (a.status === "stopping") return out;
  if (hasPane(a) && !isCleanExitPostmortem(a)) out.push("inspect", "openPane");
  return out;
}

/** Actions in the "more" overflow = everything available minus what's already shown inline. */
export function moreActions(a: AgentVM): ActionId[] {
  const inline = new Set(primaryActions(a));
  return actionsFor(a).filter((id) => !inline.has(id));
}
