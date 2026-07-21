/**
 * t-610705 (SDD 410 Phase C.0) — the Control cockpit's internal router. Maintainer mandate
 * (2026-07-21): ALL screens open inside Control as subroutes (SPA model — board == task list;
 * task detail/edit/new are subroutes of the board). This module is the seam every future group
 * (C.1 Board subroutes, C.2 Fleet subroutes, C.3 Handoff, C.4 Pins) extends.
 *
 * Design hardened via an adversarial dueto (probe-840f7a80, 16 findings, journal on t-610705).
 * Load-bearing decisions baked into this shape:
 *  - Routes are a discriminated union, never a bare string or Record<string,string> — every
 *    field is typed per variant. `decodeRoute` is the ONE total runtime decoder at every trust
 *    boundary (webview messages, persisted state); it rejects unknown/extra fields.
 *  - `parentRoute` is meant to be an EXHAUSTIVE switch over `route.kind` once there is more than
 *    one kind to be exhaustive OVER — see the note above each function below. No generic
 *    structural derivation, ever, even once real hierarchy (task-edit -> task-detail -> mission)
 *    exists.
 *  - `refreshPolicy` is per-kind, not a global timer default — a future entity/form route can opt
 *    out of the 3s auto-refresh without touching call sites that don't care.
 *
 * Only the "section" kind exists today (C.1-C.4 add sibling kinds). A route with only one kind
 * looks over-engineered in isolation; it earns its keep the moment C.1 adds a second one.
 */
import type { CockpitSectionId } from "./model.js";
import { resolveCockpitSection, isCockpitSectionId } from "./resolveSection.js";

/** A top-level Control tab. Sections have no parent — they ARE the top of the hierarchy. */
export interface CockpitSectionRoute {
  readonly kind: "section";
  readonly section: CockpitSectionId;
}

// C.1 adds taskDetail/taskForm; C.2 adds agentActivity/agentProbes; C.3 folds handoff into a
// section (no new kind); C.4 adds pinEdit. Extend this union, then satisfy parentRoute/decodeRoute/
// refreshPolicy's exhaustiveness checks — the compiler is the checklist.
export type CockpitRoute = CockpitSectionRoute;

/** How often the active route's data should be re-fetched on the 3s shell timer. */
export type CockpitRefreshPolicy = "poll" | "none";

// t-610705 — with a single union member, `route.kind === "section"` already covers every
// CockpitRoute; there is no unreachable branch to guard against yet, so these are straight-line,
// not switch/default-with-never. The FIRST time C.1 adds a second `kind`, convert each of these to
// a switch with a `default: return assertNever(route)` — TypeScript's real exhaustiveness checking
// only earns its keep (and narrows correctly) once there is more than one member to exclude.

export function routeKey(route: CockpitRoute): string {
  return `section:${route.section}`;
}

export function parentRoute(_route: CockpitRoute): CockpitRoute | null {
  // sections are top-level; no parent to derive.
  return null;
}

export function refreshPolicy(_route: CockpitRoute): CockpitRefreshPolicy {
  // matches today's behavior exactly — every section already polls on the shared 3s timer.
  return "poll";
}

/** Plain (non-localized) slug for logging/breadcrumb keys. UI localizes via its own strings map. */
export function formatRoute(route: CockpitRoute): string {
  return route.section;
}

export const routes = {
  section: (section: CockpitSectionId): CockpitSectionRoute => ({ kind: "section", section }),
};

/**
 * The ONE runtime decoder for a route arriving from an untrusted boundary (webview message,
 * persisted panel state). Rejects unknown kinds, missing/extra fields, and invalid section ids —
 * returns null rather than guessing, so callers choose their own fallback (usually
 * `routes.section("overview")`).
 */
export function decodeRoute(raw: unknown): CockpitRoute | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "section") return null;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("section")) return null;
  if (!isCockpitSectionId(obj.section)) return null;
  return { kind: "section", section: obj.section };
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
