import type { WebviewAppName } from "../../apps/vscode-extension/src/webview/webviewApps.js";

/** 350 KB — SDD 410's eager gate, carried forward per app rather than for the one app that used to exist. */
const EAGER_BUDGET_BYTES = 350 * 1024;

/**
 * Eager-entry budgets, outside the shipped manifesto. Indexed by the same union of app names so a
 * new surface without a row is a typecheck error, not a silent pass.
 */
export const WEBVIEW_APP_EAGER_BUDGET_BYTES = {
  "section-app-fixture": 64 * 1024,
  "task-detail": EAGER_BUDGET_BYTES,
  "pin-preview": EAGER_BUDGET_BYTES,
  "terminal-studio-shell": EAGER_BUDGET_BYTES,
  "schedule-studio-shell": EAGER_BUDGET_BYTES,
  "agent-studio-shell": EAGER_BUDGET_BYTES,
  "board": EAGER_BUDGET_BYTES,
  "inspector": EAGER_BUDGET_BYTES,
  "plugins": EAGER_BUDGET_BYTES,
  "runtime-ops": EAGER_BUDGET_BYTES,
  "runtime-config": EAGER_BUDGET_BYTES,
  "human-inbox": EAGER_BUDGET_BYTES,
  "handoff": EAGER_BUDGET_BYTES,
  "system": EAGER_BUDGET_BYTES,
  "worktrees": EAGER_BUDGET_BYTES,
  "keys": EAGER_BUDGET_BYTES,
  "onboarding": EAGER_BUDGET_BYTES,
  "settings": EAGER_BUDGET_BYTES,
  "companion": EAGER_BUDGET_BYTES,
  "activity": EAGER_BUDGET_BYTES,
  "review": EAGER_BUDGET_BYTES,
  "probes": EAGER_BUDGET_BYTES,
} as const satisfies Record<WebviewAppName, number>;

/**
 * Budget for the whole REACHABLE graph of one app: its eager entry plus every chunk reachable from it.
 * The eager budget alone cannot see the cost this phase actually risks — code-splitting makes it trivial to
 * keep an entry small by pushing everything behind a dynamic import, and a reader six months from now
 * comparing against 410's ~244 KB deserves to know whether the reversal moved bytes or merely moved them.
 */
export const WEBVIEW_APP_REACHABLE_BUDGET_BYTES = 2 * 1024 * 1024;
