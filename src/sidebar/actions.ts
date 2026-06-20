import type { AgentVM } from "./types";

/**
 * spec 237 — the pure capability/action matrix (no vscode, no preact). Mirrors the tree's `when`-clause
 * gating (package.json view/item/context over agentContextValue): each agent offers ONLY the actions its
 * state + capabilities allow. The webview renders a curated PRIMARY subset inline + a "more" menu for the
 * rest. Unit-tested. Wiring these ids to real commands is the next increment.
 */
export type ActionId =
  | "inspect" | "kill" | "restart" | "spawn" | "resume" | "fork" | "verify" | "reanchor"
  | "promote" | "reviewWorktree" | "createPr" | "removeWorktree" | "edit" | "editYaml" | "clone" | "rename" | "delete";

export const ACTION_META: Record<ActionId, { icon: string; label: string }> = {
  inspect: { icon: "eye", label: "Open terminal" },
  kill: { icon: "primitive-square", label: "Kill" },
  restart: { icon: "debug-restart", label: "Restart" },
  spawn: { icon: "play", label: "Start" },
  resume: { icon: "debug-continue", label: "Resume (with context)" },
  fork: { icon: "git-branch", label: "Fork session" },
  verify: { icon: "verified", label: "Verify" },
  reanchor: { icon: "compass", label: "Re-anchor to role" },
  promote: { icon: "save", label: "Save to tachyon.yml" },
  reviewWorktree: { icon: "git-compare", label: "Review worktree changes" },
  createPr: { icon: "git-pull-request", label: "Create PR" },
  removeWorktree: { icon: "trash", label: "Remove worktree" },
  edit: { icon: "edit", label: "Edit in Studio" },
  editYaml: { icon: "file-code", label: "Edit YAML" },
  clone: { icon: "copy", label: "Clone" },
  rename: { icon: "pencil", label: "Rename" },
  delete: { icon: "trash", label: "Delete" },
};

const isRunning = (a: AgentVM) => a.status === "running" || a.status === "needs" || a.status === "idle";
/** A tmux pane exists — live, crashed, or a clean-exit postmortem. Only a killed/never-started "stopped"
 *  row has no pane. With a pane: inspect/kill(dismiss)/restart. Without: spawn. Mirrors the tree. */
const hasPane = (a: AgentVM) => a.status !== "stopped" || !!a.exited;
/** Resume (with saved context) — the tree offers it for stopped|crashed (incl. clean-exit) when resumable. */
const canResume = (a: AgentVM) => !!a.resumable && (a.status === "stopped" || a.status === "crashed");

/** Every action available for an agent, gated by state + capability (the full set; "more" menu source). */
export function actionsFor(a: AgentVM): ActionId[] {
  const out: ActionId[] = [];
  if (hasPane(a)) out.push("inspect", "kill", "restart");
  else out.push("spawn");
  if (canResume(a)) out.push("resume");
  if (a.fork) out.push("fork");
  if (a.verifiable) out.push("verify");
  if (isRunning(a) && a.ai) out.push("reanchor");
  if (a.worktree) out.push("reviewWorktree", "createPr", "removeWorktree");
  if (a.adhoc) out.push("promote");
  out.push("edit", "editYaml", "clone", "rename", "delete");
  return out;
}

/** The curated subset shown inline on the row (the rest live behind "more"). Keeps the overlay narrow. */
export function primaryActions(a: AgentVM): ActionId[] {
  const out: ActionId[] = [];
  if (hasPane(a)) out.push("inspect", "kill", "restart");
  else out.push("spawn");
  if (canResume(a)) out.push("resume");
  if (a.fork) out.push("fork");
  if (a.verifiable) out.push("verify");
  return out.slice(0, 5);
}

/** Actions in the "more" overflow = everything available minus what's already shown inline. */
export function moreActions(a: AgentVM): ActionId[] {
  const inline = new Set(primaryActions(a));
  return actionsFor(a).filter((id) => !inline.has(id));
}
