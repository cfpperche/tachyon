import type { SectionId } from "./model.js";
import type { HumanInboxKind } from "../humanInbox/model.js";
import type { StudioId } from "../webview/shared/studio/studioIds.js";
/** A top-level Control tab. Sections have no parent — they ARE the top of the hierarchy. */
export interface CockpitSectionRoute {
  readonly kind: "section";
  readonly section: SectionId;
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
 * t-610705 (SDD 410 Phase D, D3) — every ProductRoute kind EXCEPT the two studio kinds. This is
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
export type ProductRoute =
  | CockpitNonStudioRoute
  | CockpitStudioNewRoute
  | CockpitStudioEditRoute;


/** How often the active route's data should be re-fetched on the 3s shell timer. */
export type CockpitRefreshPolicy = "poll" | "none";


export interface CockpitPanelStateV1 {
  schemaVersion: 1;
  view: "tachyonCockpit";
  section?: SectionId;
  wsHash?: string;
}


export interface CockpitPanelStateV2 {
  schemaVersion: 2;
  view: "tachyonCockpit";
  route: ProductRoute;
  wsHash?: string;
}


/** Persisted shape is a union so a v1 disk record from before this PR still decodes. */
export type CockpitPanelState = CockpitPanelStateV1 | CockpitPanelStateV2;
