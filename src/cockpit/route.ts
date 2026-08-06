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
 *
 * t-337cdf — retained after Control's renderer was removed because the live `CockpitModel`
 * contract still type-imports `CockpitRoute` for `activeRoute`, while the preview fixture builds
 * route-shaped compatibility models with `routes`. Removing this module therefore belongs with
 * dissolving that remaining model contract, not with deleting the retired host in isolation.
 */
import type { CockpitSectionId } from "./model.js";
import { HUMAN_INBOX_KINDS, type HumanInboxKind } from "../humanInbox/model.js";
import { resolveCockpitSection, isCockpitSectionId } from "./resolveSection.js";
import { isStudioId, type StudioId } from "./studioIds.js";

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

/**
 * t-610705 (SDD 410 Phase D, D3) — every CockpitRoute kind EXCEPT the two studio kinds. This is
 * exactly the set a pin's `returnRoute` is allowed to hold (design dueto probe-43bca1cc blocker:
 * "studio kinds excluded by construction" must be a TYPE guarantee, not just a runtime convention —
 * a convention-only guard left a real gap where trusted internal code could still construct an
 * invalid nested-studio returnRoute). Never add `CockpitStudioNewRoute`/`CockpitStudioEditRoute` to
 * this union — a route that can return to ANOTHER studio route has no defined semantics anywhere in
 * this file (parentRoute/navSection would need to recurse into a second studio's own policy).
 */
/**
 * t-ace77f — one workspace's Project Handoff document. It used to be a nav TAB, which put a
 * single per-workspace document beside twelve dashboards and gave the human a tab to close their
 * way out of; it is a detail route now, entered from the sidebar's `handoff · N` bar and leaving by
 * breadcrumb to Overview. `wsHash` is the entity's immutable locator, same rule as every other
 * entity route here: switching the shell's workspace scope does not re-target an open document.
 */
export interface CockpitProjectHandoffRoute {
  readonly kind: "project-handoff";
  readonly wsHash: string;
}

/**
 * t-e76acc — one Human Inbox item, opened: a subroute of the Inbox section.
 *
 * Keyed by `itemKind` AND `itemId`, never the id alone. Approvals and validations are independent
 * stores with independent id spaces, and a route that named only an id would have to GUESS which
 * store to read — the exact "a validation could be reached through an approval path" ambiguity the
 * ratified design refuses to introduce anywhere else. `wsHash` is the entity's immutable locator,
 * same rule as every other entity route in this file: switching Control's workspace scope while an
 * item is open must not swap the decision out from under the person deciding it.
 */
export interface CockpitInboxItemRoute {
  readonly kind: "inbox-item";
  readonly wsHash: string;
  readonly itemKind: HumanInboxKind;
  readonly itemId: string;
}

export type CockpitNonStudioRoute =
  | CockpitSectionRoute
  | CockpitTaskDetailRoute
  | CockpitAgentActivityRoute
  | CockpitAgentProbesRoute
  | CockpitWorkspaceProbesRoute
  | CockpitProjectHandoffRoute
  | CockpitInboxItemRoute;

/**
 * t-610705 (SDD 410 Phase D, D0) — a fresh (unsaved) entity being drafted for one of the
 * StudioPanelManagerBase-based studios (studios-routes-design.md). `studio` is the closed
 * `StudioId` union — NOT 14 explicit route kinds, per the design dueto's Q1 (sound as long as
 * StudioId stays a true runtime discriminator: `satisfies Record<StudioId,...>` registries, no
 * casts, one exhaustive test — see studioRegistry.ts). `wsHash` is the immutable workspace locator,
 * same reasoning as every other entity route in this file.
 *
 * `returnRoute` (D3) — meaningful ONLY for `studio:"pin"` (studios-routes-design.md: pin is
 * "nav-less", its close-target is this explicit slot, not `studioParentSection`'s static table).
 * MANDATORY (no optional fields, per this file's own shipped rule), always `null` for every other
 * studio. Captured automatically by Cockpit.ts's `navigate()` at the moment a pin route commits —
 * callers never set it themselves, see routes.studioNew/studioEdit below.
 */
export interface CockpitStudioNewRoute {
  readonly kind: "studio-new";
  readonly studio: StudioId;
  readonly wsHash: string;
  readonly returnRoute: CockpitNonStudioRoute | null;
}

/**
 * t-610705 (SDD 410 Phase D, D0) — an existing entity open for edit in a studio. `entityId` is the
 * adapter's own id space (e.g. a command name) — opaque to the router. `returnRoute` — see
 * CockpitStudioNewRoute's doc comment; identical rule.
 */
export interface CockpitStudioEditRoute {
  readonly kind: "studio-edit";
  readonly studio: StudioId;
  readonly wsHash: string;
  readonly entityId: string;
  readonly returnRoute: CockpitNonStudioRoute | null;
}

// C.1 also adds task-new/task-edit... superseded: Task Studio (task-edit/task-new) now lands as
// studio-new/studio-edit with studio:"task" in Phase D D2 (studios-routes-design.md), not a
// separate route kind — same for Pin Studio (D3, studio:"pin", nav-less parent policy). C.3 folded
// handoff into a section (no new kind, unaffected). Extend the union below (a new StudioId member,
// added to studioIds.ts's STUDIO_IDS), then satisfy parentRoute/decodeRoute/refreshPolicy/
// navSection's exhaustiveness checks — the compiler is the checklist (assertNeverRoute's `never`
// parameter fails to compile until every function below handles the new kind/studio).
export type CockpitRoute =
  | CockpitNonStudioRoute
  | CockpitStudioNewRoute
  | CockpitStudioEditRoute;

/**
 * t-610705 (Phase D) — per-StudioId parent-section policy (studios-routes-design.md's registry
 * table). A studio's PARENT is a static function of its StudioId alone for every studio EXCEPT pin
 * (nav-less, D3 — its close-target is the route's own `returnRoute` slot, not derivable from the
 * StudioId alone) — pin is excluded from this function's PARAMETER TYPE (not just its switch), per
 * design-dueto probe-43bca1cc's finding: a nominally-exhaustive `case "pin": throw` would make an
 * invalid call (passing "pin" here) type-correct and turn a design invariant into a runtime crash;
 * omitting "pin" from the parameter type instead makes every call site that hasn't already narrowed
 * away "pin" a COMPILE error. Kept as its own exhaustive switch (not folded into parentRoute's
 * route.kind switch) so adding a StudioId without a matching case fails to compile independently of
 * adding a new route KIND.
 */
function studioParentSection(studio: Exclude<StudioId, "pin">): CockpitSectionId {
  switch (studio) {
    case "command":
    case "terminal":
    case "runbook":
    case "schedule":
    case "agent":
      return "fleet";
    case "task":
      // t-610705 (Phase D, D2) — "mission" for BOTH studio-new (no entity yet, this is the correct
      // fallback per studios-routes-design.md's parent-policy table) and as navSection's nav-tab
      // answer for studio-edit too (parentRoute's studio-edit case overrides the PARENT itself to
      // task-detail(ws,id) below — a real subroute, not a section — but the nav tab that reads as
      // active is still "mission" either way, so this single case correctly answers both callers).
      return "mission";
    default: {
      const _never: never = studio;
      throw new Error(`cockpit route: unhandled studio ${JSON.stringify(_never)}`);
    }
  }
}

/** How often the active route's data should be re-fetched on the 3s shell timer. */
export type CockpitRefreshPolicy = "poll" | "none";

function assertNeverRoute(route: never): never {
  throw new Error(`cockpit route: unhandled kind ${JSON.stringify(route)}`);
}

/**
 * t-610705 (Phase D, D3) — `studio-new`/`studio-edit`'s key DELIBERATELY excludes `returnRoute`: it
 * is provenance metadata about where to go back, not part of the route's own identity. If it were
 * included, re-opening the SAME pin from a different origin route would look like a different route,
 * defeating `requestNavigate`'s same-identity re-entry check (`routeKey(route) === routeKey(currentRoute)`).
 */
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
    case "project-handoff":
      return `project-handoff:${route.wsHash}`;
    case "inbox-item":
      return `inbox-item:${route.wsHash}:${route.itemKind}:${route.itemId}`;
    case "studio-new":
      return `studio-new:${route.studio}:${route.wsHash}`;
    case "studio-edit":
      return `studio-edit:${route.studio}:${route.wsHash}:${route.entityId}`;
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
    case "inbox-item":
      // t-e76acc — back to the aggregated list, which is the whole point of the surface: a human
      // works the inbox down, item by item, without being returned to a per-kind tab each time.
      return { kind: "section", section: "inbox" };
    case "project-handoff":
      // t-ace77f — Overview, not a Handoff tab: there is no Handoff tab any more, and Overview is
      // where the document's own quick-nav entry lives. Back must never land on a tab that is gone.
      return { kind: "section", section: "overview" };
    case "studio-new":
      // t-610705 (Phase D, D3) — pin is nav-less: its close-target is its OWN captured
      // `returnRoute`, never `studioParentSection`'s static table. Falls back to Overview only when
      // no return route was ever captured (e.g. a pin route decoded straight off a deep link with no
      // prior Control session) — mirrors decodePanelState's own "never trusts a malformed/absent
      // route" fallback elsewhere in this file.
      if (route.studio === "pin") return route.returnRoute ?? { kind: "section", section: "overview" };
      return { kind: "section", section: studioParentSection(route.studio) };
    case "studio-edit":
      // t-610705 (Phase D, D2) — task is the one studio whose EDIT parent is a specific entity's
      // own subroute, not a flat section (studios-routes-design.md's table: "task | edit →
      // task-detail(ws, id)") — this is the whole "task-edit→task-detail chain" the D2 line item
      // asks for: Control's existing generic back/breadcrumb navigation (built on parentRoute,
      // unchanged) now lands on the task instead of the whole Board. No save-triggered auto-
      // navigation was added — an adversarial dueto (REDESIGN verdict) found that unsafe to bolt
      // onto beginStudioSave without a much larger atomic-transaction redesign; this reuses the
      // ALREADY-safe, already-proven back-navigation path instead.
      if (route.studio === "task") return { kind: "task-detail", wsHash: route.wsHash, taskId: route.entityId };
      // t-610705 (Phase D, D3) — same returnRoute policy as studio-new above.
      if (route.studio === "pin") return route.returnRoute ?? { kind: "section", section: "overview" };
      return { kind: "section", section: studioParentSection(route.studio) };
    default:
      return assertNeverRoute(route);
  }
}

/**
 * Which nav-bar tab should read as active while this route is showing — `null` for pin (D3): it has
 * no home tab in Control's nav bar (studios-routes-design.md's parent/nav table: "none, navSection:
 * null, nav-less"). Callers that need a definite `CockpitSectionId` (which background section data
 * stays warm underneath a studio form) fall back to "overview" AT THE CALL SITE, not here — keeping
 * this function's own return value a genuine tri-state (design-dueto probe-43bca1cc minor finding:
 * coercing null to "overview" inside this function would make nav-less state indistinguishable from
 * "the Overview tab is genuinely active" for any future caller, e.g. diagnostics).
 */
export function navSection(route: CockpitRoute): CockpitSectionId | null {
  switch (route.kind) {
    case "section":
      return route.section;
    case "task-detail":
      return "mission";
    case "agent-activity":
    case "agent-probes":
    case "workspace-probes":
      return "fleet";
    case "inbox-item":
      // the Inbox tab stays lit while one of its items is open — unlike Handoff, this subroute HAS a
      // home tab, and it is the one whose count the human is working down.
      return "inbox";
    case "project-handoff":
      // t-ace77f — nav-less, the same tri-state pin uses: no tab reads as active, and callers that
      // need a concrete section for BACKGROUND data fall back to "overview" at their own call site.
      // Answering "overview" here instead would light the Overview tab up as if it were open.
      return null;
    case "studio-new":
    case "studio-edit":
      return route.studio === "pin" ? null : studioParentSection(route.studio);
    default:
      return assertNeverRoute(route);
  }
}

/** True for either studio route kind — the one place callers gate "is a studio form active" without
 *  caring whether it's new or edit (nav-transaction guard, CSS co-load, embed-host styling). */
export function isStudioRoute(route: CockpitRoute): route is CockpitStudioNewRoute | CockpitStudioEditRoute {
  return route.kind === "studio-new" || route.kind === "studio-edit";
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
    case "inbox-item":
      // t-e76acc — a decision surface, not a dashboard: a 3s refetch under a half-typed result note
      // (or mid-read of a verbatim approval payload) is only downside. Acting on the item re-pushes
      // it through the same fan-out the Approvals/Validations sections already use.
      return "none";
    case "project-handoff":
      // t-ace77f — unchanged from when this was a section: the same 3s tick keeps the `Needs
      // distill` count and the document honest while the human reads. Becoming a route was a
      // navigation decision, not a refresh one.
      return "poll";
    case "studio-new":
    case "studio-edit":
      // t-610705 (Phase D, D0) — a form, not a dashboard: a timer-driven refetch would either
      // clobber in-progress edits or (worse) silently race the nav-transaction FSM's frozen-form
      // invariant (studios-routes-design.md). Reference-data refresh rides its own fan-out instead.
      return "none";
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
    case "project-handoff":
      return "project handoff";
    case "inbox-item":
      return `inbox ${route.itemKind} ${route.itemId}`;
    case "studio-new":
      return `${route.studio} new`;
    case "studio-edit":
      return `${route.studio} ${route.entityId}`;
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
  projectHandoff: (wsHash: string): CockpitProjectHandoffRoute => ({ kind: "project-handoff", wsHash }),
  inboxItem: (wsHash: string, itemKind: HumanInboxKind, itemId: string): CockpitInboxItemRoute => ({
    kind: "inbox-item",
    wsHash,
    itemKind,
    itemId,
  }),
  // t-610705 (Phase D, D3) — `returnRoute` defaults to `null` for every caller (every D0-D2 call
  // site is unaffected). Real callers never pass it explicitly even for pin: Cockpit.ts's
  // `navigate()` captures the real value automatically at the moment a pin route commits (design-
  // dueto probe-43bca1cc — capture must be a host-owned side effect of the commit itself, not
  // something a caller pre-computes, or same-identity re-entry / chained pin↔pin navigation loses
  // the originally captured value). The parameter exists so decodeRoute/tests/preview fixtures can
  // still construct a route with a specific returnRoute directly.
  //
  // t-610705 (Phase D, D3, design-dueto probe-12f603f3 major finding) — a RUNTIME guard, not an
  // overloaded signature: overloads (`studio:"pin"` vs `Exclude<StudioId,"pin">`) were tried and
  // reverted — they break every GENERIC caller typed over the whole `StudioId` union (extension.ts's
  // `registerLegacyStudioRedirect` helper, this file's own StudioId-driven test loops), which never
  // pass `returnRoute` at all but still fail overload resolution since a union argument must fit ONE
  // overload branch wholesale. Mirrors the file's own existing precedent one line below (`studio ===
  // "task"` is the same class of runtime-only defensive assertion, not a type-level one).
  studioNew: (studio: StudioId, wsHash: string, returnRoute: CockpitNonStudioRoute | null = null): CockpitStudioNewRoute => {
    // t-610705 (Phase D, D2) — mirrors decodeRoute's own rejection: every "new task" caller must
    // pre-mint an id and call studioEdit directly instead (see decodeRoute's doc comment on this
    // same rule). A defensive assertion, not a reachable production path.
    if (studio === "task") throw new Error("routes.studioNew: task is never id-less — pre-mint an id and call routes.studioEdit instead");
    if (returnRoute !== null && studio !== "pin") throw new Error(`routes.studioNew: returnRoute is only meaningful for "pin", not "${studio}"`);
    return { kind: "studio-new", studio, wsHash, returnRoute };
  },
  studioEdit: (studio: StudioId, wsHash: string, entityId: string, returnRoute: CockpitNonStudioRoute | null = null): CockpitStudioEditRoute => {
    if (returnRoute !== null && studio !== "pin") throw new Error(`routes.studioEdit: returnRoute is only meaningful for "pin", not "${studio}"`);
    return { kind: "studio-edit", studio, wsHash, entityId, returnRoute };
  },
};

/**
 * t-610705 (Phase D, D3) — the 5 non-studio kinds only, factored out of decodeRoute so a pin route's
 * `returnRoute` field can be decoded WITHOUT ever recursing into decodeRoute's own studio-new/
 * studio-edit branches (design-dueto probe-43bca1cc major finding: a naive `decodeRoute(returnRoute)`
 * recursive call is only non-recursive in practice because the OUTER caller rejects a decoded studio
 * result — an untrusted payload could still make the decoder walk an arbitrarily deep nested-studio
 * chain before that rejection happens. This function structurally cannot decode a studio kind at
 * all, so there is nothing to walk).
 */
function decodeNonStudioRoute(raw: unknown): CockpitNonStudioRoute | null {
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
  if (obj.kind === "inbox-item") {
    if (keys.length !== 4 || !keys.includes("wsHash") || !keys.includes("itemKind") || !keys.includes("itemId")) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    // the closed kind set, checked here rather than trusted: this decoder is the trust boundary for
    // persisted panel state and every webview message, and an unrecognized kind has no store to read.
    // Total decoder at a trust boundary: the kind must be one this build knows, so a new kind from a
    // newer window is rejected rather than routed to a renderer that has no arm for it.
    if (typeof obj.itemKind !== "string" || !(HUMAN_INBOX_KINDS as readonly string[]).includes(obj.itemKind)) return null;
    const itemKind = obj.itemKind as HumanInboxKind;
    if (typeof obj.itemId !== "string" || !obj.itemId) return null;
    return { kind: "inbox-item", wsHash: obj.wsHash, itemKind, itemId: obj.itemId };
  }
  if (obj.kind === "workspace-probes" || obj.kind === "project-handoff") {
    if (keys.length !== 2 || !keys.includes("wsHash")) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    return { kind: obj.kind, wsHash: obj.wsHash };
  }
  return null;
}

/**
 * t-610705 (Phase D, D3) — validates a `studio-new`/`studio-edit` route's raw `returnRoute` field.
 * `null` is always valid (the "never captured / not pin" case). A non-null value is valid ONLY for
 * `studio:"pin"` (every other studio must carry exactly `null` — design-dueto finding: the pin-only
 * invariant must be enforced at decode time, not left to convention) — and only when it decodes via
 * `decodeNonStudioRoute` AND, for a return route that itself carries a `wsHash`, that `wsHash`
 * matches the outer pin route's own `wsHash` (a revive/deep-link whose persisted returnRoute points
 * at a DIFFERENT workspace than the pin route itself is stale/mismatched data, not a route to trust —
 * design-dueto finding on revive-mismatch). Returns `undefined` as a distinct "reject the whole outer
 * route" sentinel (not `null`, which is itself a legitimate decoded value here).
 */
function decodeReturnRoute(raw: unknown, studio: StudioId, wsHash: string): CockpitNonStudioRoute | null | undefined {
  if (raw === null) return null;
  if (studio !== "pin") return undefined;
  const decoded = decodeNonStudioRoute(raw);
  if (!decoded) return undefined;
  if ("wsHash" in decoded && decoded.wsHash !== wsHash) return undefined;
  return decoded;
}

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
  if (obj.kind === "studio-new") {
    if (keys.length !== 4 || !keys.includes("studio") || !keys.includes("wsHash") || !keys.includes("returnRoute")) return null;
    if (!isStudioId(obj.studio)) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    // t-610705 (Phase D, D2) — "task" is declared in StudioId (registry exhaustiveness, satisfies
    // Record<StudioId,...>) but its "new" session is NEVER actually id-less: attachments (image/
    // sketch/prototype) are keyed by the task's own id from the moment the form opens, so every real
    // caller pre-mints via mintTaskId() and navigates straight to studio-edit instead (an adversarial
    // dueto's minor finding: an unreachable-but-nominally-valid route is a footgun for deep links/
    // tests/future callers, not harmless exhaustiveness scaffolding — reject it here, fail closed,
    // rather than silently reaching semantics no adapter actually supports).
    if (obj.studio === "task") return null;
    const returnRoute = decodeReturnRoute(obj.returnRoute, obj.studio, obj.wsHash);
    if (returnRoute === undefined) return null;
    return { kind: "studio-new", studio: obj.studio, wsHash: obj.wsHash, returnRoute };
  }
  if (obj.kind === "studio-edit") {
    if (keys.length !== 5 || !keys.includes("studio") || !keys.includes("wsHash") || !keys.includes("entityId") || !keys.includes("returnRoute")) return null;
    if (!isStudioId(obj.studio)) return null;
    if (typeof obj.wsHash !== "string" || !obj.wsHash) return null;
    if (typeof obj.entityId !== "string" || !obj.entityId) return null;
    const returnRoute = decodeReturnRoute(obj.returnRoute, obj.studio, obj.wsHash);
    if (returnRoute === undefined) return null;
    return { kind: "studio-edit", studio: obj.studio, wsHash: obj.wsHash, entityId: obj.entityId, returnRoute };
  }
  return decodeNonStudioRoute(raw);
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
    const migrated = migrateRetiredHandoffSection((obj as CockpitPanelStateV2).route, wsHash);
    if (migrated) return { route: migrated, wsHash };
  }
  // v1 (or a malformed/unversioned record): decode the bare section, defaulting to overview.
  const v1 = (obj as CockpitPanelStateV1).section;
  const migratedV1 = migrateRetiredHandoffSection({ kind: "section", section: v1 }, wsHash);
  if (migratedV1) return { route: migratedV1, wsHash };
  const section = resolveCockpitSection(v1);
  return { route: { kind: "section", section }, wsHash };
}

/**
 * t-ace77f — a window reloaded on the retired Handoff TAB must reopen the document it was showing,
 * not silently drop to Overview. `section: "handoff"` stopped decoding the moment it left
 * `CockpitSectionId`, so this is the one place that still recognizes it — and only when the record
 * also carries the workspace the route now needs as its locator. Without one there is nothing to
 * open, and the caller's Overview fallback is the honest answer.
 */
function migrateRetiredHandoffSection(raw: unknown, wsHash: string | undefined): CockpitProjectHandoffRoute | null {
  if (!wsHash) return null;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return obj.kind === "section" && obj.section === "handoff" ? { kind: "project-handoff", wsHash } : null;
}
