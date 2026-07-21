/**
 * t-610705 (SDD 410 Phase C.0/C.1) — the Control cockpit's internal router. Maintainer mandate
 * (2026-07-21): ALL screens open inside Control as subroutes (SPA model — board == task list;
 * task detail/edit/new are subroutes of the board). This module is the seam every group (C.1 Board
 * subroutes, C.2 Fleet subroutes, C.3 Handoff, C.4 Pins) extends.
 *
 * Design hardened via an adversarial dueto (probe-840f7a80, 16 findings, journal on t-610705).
 * Load-bearing decisions baked into this shape:
 *  - Routes are a discriminated union, never a bare string or Record<string,string> — every
 *    field is typed per variant. `decodeRoute` is the ONE total runtime decoder at every trust
 *    boundary (webview messages, persisted state); it rejects unknown/extra fields.
 *  - `parentRoute` is an EXHAUSTIVE switch over `route.kind` (assertNeverRoute) — adding a new
 *    kind without a matching case is a compile error. No generic structural derivation, ever, even
 *    though task-detail's parent genuinely IS the mission section — that mapping is spelled out
 *    explicitly per kind, not inferred.
 *  - `refreshPolicy` is per-kind, not a global timer default — task-detail already opts out (a
 *    stray 3s auto-refresh mid-read is jarring for a document view; the fan-out from real
 *    mutations elsewhere already re-pushes it — see refreshCockpitTaskDetail in Cockpit.ts). A
 *    future form route (task-new/task-edit) opts out too, for a sharper reason: don't clobber
 *    in-progress edits.
 *  - `navSection` answers "which NAV TAB should be highlighted" — distinct from parentRoute's
 *    "where does back/breadcrumb go": today they agree (task-detail's nav tab AND its breadcrumb
 *    parent are both Mission), but a future route could highlight one tab while its breadcrumb
 *    parent is a different node, so these stay two functions on purpose.
 */
import type { CockpitSectionId } from "./model.js";
import { resolveCockpitSection, isCockpitSectionId } from "./resolveSection.js";

/** A top-level Control tab. Sections have no parent — they ARE the top of the hierarchy. */
export interface CockpitSectionRoute {
  readonly kind: "section";
  readonly section: CockpitSectionId;
}

/**
 * t-610705 Phase C.1 — one task's read/edit-lite view, a subroute of the Board (mission section).
 * `wsHash` is the entity's IMMUTABLE workspace locator (router dueto finding: data identity is
 * NOT the same thing as the shell's workspace-scope selector, and must never be derived from it —
 * switching the shell scope while a task-detail route is open does not re-target this route).
 */
export interface CockpitTaskDetailRoute {
  readonly kind: "task-detail";
  readonly wsHash: string;
  readonly taskId: string;
}

/**
 * t-610705 Phase C.2 — one agent's normalized activity feed (assistant messages, tool calls, files,
 * usage), a subroute of Fleet. `wsHash` is the entity's immutable workspace locator, same reasoning
 * as task-detail's `wsHash` (router dueto): never derived from the shell's workspace-scope selector.
 */
export interface CockpitAgentActivityRoute {
  readonly kind: "agent-activity";
  readonly wsHash: string;
  readonly agent: string;
}

/**
 * t-610705 Phase C.2 — one agent's captured probe runs, a subroute of Fleet.
 */
export interface CockpitAgentProbesRoute {
  readonly kind: "agent-probes";
  readonly wsHash: string;
  readonly agent: string;
}

/**
 * t-610705 Phase C.2 — the UNFILTERED probe ledger for a workspace (an internal/debug escape hatch
 * for caller-less or orphaned records — spec 322 — never surfaced in the UI, reachable only via the
 * agent-less `tachyon.openProbes` command). A hardening-dueto finding (probe-2d90286d) flagged that
 * an `agent?: string` optional field on ONE route kind creates undefined/null/""-ambiguity across
 * routeKey/decodeRoute/persistence — so this is its OWN kind instead, not agent-probes with an
 * absent agent.
 */
export interface CockpitWorkspaceProbesRoute {
  readonly kind: "workspace-probes";
  readonly wsHash: string;
}

// C.1 also adds task-new/task-edit (Task Studio — deferred pending its own design pass, since it
// shares StudioPanelManagerBase with 8 other panels); C.3 folds handoff into a section (no new
// kind); C.4 adds pinEdit. Extend this union, then satisfy parentRoute/decodeRoute/refreshPolicy/
// navSection's exhaustiveness checks — the compiler is the checklist (assertNeverRoute's `never`
// parameter fails to compile until every function below handles the new kind).
export type CockpitRoute =
  | CockpitSectionRoute
  | CockpitTaskDetailRoute
  | CockpitAgentActivityRoute
  | CockpitAgentProbesRoute
  | CockpitWorkspaceProbesRoute;

/** How often the active route's data should be re-fetched on the 3s shell timer. */
export type CockpitRefreshPolicy = "poll" | "none";

function assertNeverRoute(route: never): never {
  throw new Error(`cockpit route: unhandled kind ${JSON.stringify(route)}`);
}

export function routeKey(route: CockpitRoute): string {
  switch (route.kind) {
    case "section":
      return `section:${route.section}`;
    case "task-detail":
      return `task-detail:${route.wsHash}:${route.taskId}`;
    case "agent-activity":
      return `agent-activity:${route.wsHash}:${route.agent}`;
    case "agent-probes":
      return `agent-probes:${route.wsHash}:${route.agent}`;
    case "workspace-probes":
      return `workspace-probes:${route.wsHash}`;
    default:
      return assertNeverRoute(route);
  }
}

/** Where breadcrumb/back navigation goes. Sections are top-level (no parent). */
export function parentRoute(route: CockpitRoute): CockpitRoute | null {
  switch (route.kind) {
    case "section":
      return null;
    case "task-detail":
      return { kind: "section", section: "mission" };
    case "agent-activity":
    case "agent-probes":
    case "workspace-probes":
      return { kind: "section", section: "fleet" };
    default:
      return assertNeverRoute(route);
  }
}

/** Which nav-bar tab should read as active while this route is showing. */
export function navSection(route: CockpitRoute): CockpitSectionId {
  switch (route.kind) {
    case "section":
      return route.section;
    case "task-detail":
      return "mission";
    case "agent-activity":
    case "agent-probes":
    case "workspace-probes":
      return "fleet";
    default:
      return assertNeverRoute(route);
  }
}

/**
 * True only when `route` genuinely IS that section (not merely a subroute nested under it, e.g.
 * task-detail's parent). Distinct from `navSection` on purpose: nav highlighting wants "which tab
 * reads as active", but a section's own data-refresh guard wants "is this section literally what's
 * rendered right now" — the board's data has no reason to keep refreshing while a task-detail
 * subroute is what's actually on screen.
 */
export function isSection(route: CockpitRoute, section: CockpitSectionId): boolean {
  return route.kind === "section" && route.section === section;
}

export function refreshPolicy(route: CockpitRoute): CockpitRefreshPolicy {
  switch (route.kind) {
    case "section":
      // matches today's behavior exactly — every section already polls on the shared 3s timer.
      return "poll";
    case "task-detail":
      // a document view, not a dashboard — real mutations already re-push via the onTasksChanged
      // fan-out; a timer-driven refetch mid-read (or mid-typing in the assignee field) is only downside.
      return "none";
    case "agent-activity":
      // a LIVE feed with its own push (fs.watchFile on the durable log + a 1s attention poll) — the
      // shared 3s shell timer must never re-drive it: Cockpit.ts's sendSectionModule() has no
      // agent-activity branch at all (hardening dueto probe-2d90286d blocker — conflating a route's
      // own push with the shell's periodic poll reproduces the exact bug class t-0fc9ee just fixed,
      // this time as a spammed image-resend rather than a wiped update-check).
      return "none";
    case "agent-probes":
    case "workspace-probes":
      // a cheap local disk read (ProbeStore), same cost class as Mission/Approvals/Validations —
      // polls like any other section; the fan-out (refreshCockpitProbes) covers the gap between ticks.
      return "poll";
    default:
      return assertNeverRoute(route);
  }
}

/** Plain (non-localized) slug for logging/breadcrumb keys. UI localizes via its own strings map. */
export function formatRoute(route: CockpitRoute): string {
  switch (route.kind) {
    case "section":
      return route.section;
    case "task-detail":
      return `task ${route.taskId}`;
    case "agent-activity":
      return `${route.agent} activity`;
    case "agent-probes":
      return `${route.agent} probes`;
    case "workspace-probes":
      return "probes";
    default:
      return assertNeverRoute(route);
  }
}

export const routes = {
  section: (section: CockpitSectionId): CockpitSectionRoute => ({ kind: "section", section }),
  taskDetail: (wsHash: string, taskId: string): CockpitTaskDetailRoute => ({ kind: "task-detail", wsHash, taskId }),
  agentActivity: (wsHash: string, agent: string): CockpitAgentActivityRoute => ({ kind: "agent-activity", wsHash, agent }),
  agentProbes: (wsHash: string, agent: string): CockpitAgentProbesRoute => ({ kind: "agent-probes", wsHash, agent }),
  workspaceProbes: (wsHash: string): CockpitWorkspaceProbesRoute => ({ kind: "workspace-probes", wsHash }),
};

/**
 * The ONE runtime decoder for a route arriving from an untrusted boundary (webview message,
 * persisted panel state). Rejects unknown kinds, missing/extra fields, and invalid values —
 * returns null rather than guessing, so callers choose their own fallback (usually
 * `routes.section("overview")`).
 */
export function decodeRoute(raw: unknown): CockpitRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (obj.kind === "section") {
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("section")) return null;
    if (!isCockpitSectionId(obj.section)) return null;
    return { kind: "section", section: obj.section };
  }
  if (obj.kind === "task-detail") {
    if (keys.length !== 3 || !keys.includes("wsHash") || !keys.includes("taskId")) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    if (typeof obj.taskId !== "string" || !obj.taskId) return null;
    return { kind: "task-detail", wsHash: obj.wsHash, taskId: obj.taskId };
  }
  if (obj.kind === "agent-activity" || obj.kind === "agent-probes") {
    if (keys.length !== 3 || !keys.includes("wsHash") || !keys.includes("agent")) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    if (typeof obj.agent !== "string" || !obj.agent) return null;
    return { kind: obj.kind, wsHash: obj.wsHash, agent: obj.agent };
  }
  if (obj.kind === "workspace-probes") {
    if (keys.length !== 2 || !keys.includes("wsHash")) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    return { kind: "workspace-probes", wsHash: obj.wsHash };
  }
  return null;
}

const COCKPIT_PANEL_VIEW = "tachyonCockpit" as const;

export interface CockpitPanelStateV1 {
  schemaVersion: 1;
  view: typeof COCKPIT_PANEL_VIEW;
  section?: CockpitSectionId;
  wsHash?: string;
}

export interface CockpitPanelStateV2 {
  schemaVersion: 2;
  view: typeof COCKPIT_PANEL_VIEW;
  route: CockpitRoute;
  wsHash?: string;
}

/** Persisted shape is a union so a v1 disk record from before this PR still decodes. */
export type CockpitPanelState = CockpitPanelStateV1 | CockpitPanelStateV2;

/**
 * Strict per-version decode at the restore boundary ONLY — runtime state after this point is
 * always a CockpitRoute, never a persisted-shape lookalike (closes the "duplicate section/route
 * fields can diverge" finding). New panels are always PERSISTED as v2; this function is what
 * still understands v1 disk records.
 */
export function decodePanelState(raw: unknown): { route: CockpitRoute; wsHash?: string } {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Partial<CockpitPanelState>;
  const wsHash = typeof obj.wsHash === "string" ? obj.wsHash : undefined;
  if (obj.schemaVersion === 2) {
    const decoded = decodeRoute((obj as CockpitPanelStateV2).route);
    if (decoded) return { route: decoded, wsHash };
  }
  // v1 (or a malformed/unversioned record): decode the bare section, defaulting to overview.
  const section = resolveCockpitSection((obj as CockpitPanelStateV1).section);
  return { route: { kind: "section", section }, wsHash };
}
