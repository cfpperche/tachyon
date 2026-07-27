/**
 * SDD 479 — the sidebar agent card's component catalog and its default template.
 *
 * Phase 1 deliberately ships NO configuration surface: this module exists so the card is rendered
 * *through* a closed catalog with zero visible change, which is the point at which the design is
 * proven or disproven (`docs/specs/479-sidebar-agent-card-templates/plan.md` § Phasing).
 *
 * Two properties carry the whole design, and both live here rather than in the renderer:
 *
 *  1. **The catalog is closed.** `CardComponentId` is derived from `CARD_COMPONENT_IDS`, and the
 *     renderer map in the webview is a `Record<CardComponentId, …>` — so an id with no renderer, or a
 *     renderer with no id, fails to compile. An OPEN catalog would be a template language with extra
 *     steps: an id the product does not implement can only be rendered by interpreting it, and
 *     interpretation is where markup gets in.
 *  2. **The default template IS today's card.** Not a re-implementation that resembles it —
 *     `test/unit/sidebarCardTemplateEquality.test.ts` renders the real component over a fixture matrix
 *     and compares it, byte for byte, against output captured from the renderer that shipped.
 *
 * Framework-agnostic on purpose (same contract as `types.ts`): no preact, no vscode. The webview owns
 * the fragments; this module owns which fragments exist, where they may sit, and in what order.
 */
import { isAgentRow, type AgentVM } from "./types.js";

/** Bumped when the template SHAPE changes. An unknown version is refused, never guessed (phase 2). */
export const CARD_TEMPLATE_VERSION = 1;

/**
 * The three fixed regions of a card. Ratified fork 4: a flat ordered list per region — no nesting, no
 * columns, no conditionals. Regions map to the row's existing structural elements (`.row-top`,
 * `.row-meta`, and the trailing focus/detail/actions block).
 */
export const CARD_REGIONS = ["header", "meta", "footer"] as const;
export type CardRegion = (typeof CARD_REGIONS)[number];

/**
 * Every component a card can show. Derived from `AgentVM` — a component exists because a field exists,
 * never the other way round.
 *
 * NOT in the catalog, on purpose: the disclosure toggle / gutter spacer. It is tree chrome (it reveals
 * child ROWS, not a property of this agent), and a template that could hide it would make collapsed
 * children unreachable. It stays structural, rendered before the header region.
 */
export const CARD_COMPONENT_IDS = [
  // header
  "status-dot",
  "name",
  "model",
  "model-provenance",
  "metrics-pill",
  // meta
  "sub",
  "hidden-count",
  "branch",
  "config-invalid",
  "attention",
  "awaiting-human",
  "auth-required",
  "verify",
  "evidence",
  "external-tools",
  "harness",
  "resume",
  "fork",
  "continuity",
  "persistence-hooks",
  // footer
  "focus",
  "metrics-lanes",
  "actions",
] as const;

export type CardComponentId = (typeof CARD_COMPONENT_IDS)[number];

export interface CardComponentSpec {
  /** the only region this component may appear in */
  readonly region: CardRegion;
  /**
   * Rendered INSIDE the named component's own element rather than as a sibling in the region, and only
   * when that component renders. The card has two such runs — `model` and `model-provenance` live
   * inside `.name`, where the sidebar's CSS and its reading order expect them — and they are declared
   * by the CATALOG, not by the template: the template stays a flat ordered list, as ratified.
   */
  readonly inlineWith?: CardComponentId;
  /**
   * Carries a state the row cannot recover from on its own. Ratified fork 3: a template may not hide
   * these — phase 2 re-admits an omitted critical component for the affected row and says why. Phase 1
   * records the set; nothing can omit anything yet.
   */
  readonly critical?: boolean;
  /** what the component shows, in the words the settings surface will use */
  readonly describes: string;
}

export const CARD_CATALOG: Readonly<Record<CardComponentId, CardComponentSpec>> = {
  "status-dot": { region: "header", describes: "Run state as a colored dot with its label" },
  name: { region: "header", describes: "Agent name" },
  model: { region: "header", inlineWith: "name", describes: "Active model label" },
  "model-provenance": { region: "header", inlineWith: "model", describes: "Where the model label came from (spec 378)" },
  "metrics-pill": { region: "header", describes: "CPU · memory pill that expands the lanes (spec 386)" },

  sub: { region: "meta", describes: "Secondary line (exit code, command, delegation)" },
  "hidden-count": { region: "meta", describes: "Count of children hidden by collapse" },
  branch: { region: "meta", describes: "Live HEAD branch and drift (spec 384)" },
  "config-invalid": { region: "meta", critical: true, describes: "tachyon.yml is invalid; the row is read-only" },
  attention: { region: "meta", describes: "Attention state reported by the monitor" },
  "awaiting-human": { region: "meta", critical: true, describes: "The agent asked for a human (request_human_attention)" },
  "auth-required": { region: "meta", critical: true, describes: "The runtime reports it is not authenticated (SDD 477)" },
  verify: { region: "meta", critical: true, describes: "Verify gate result: pass, fail or stale" },
  evidence: { region: "meta", describes: "Evidence record counts (spec 273)" },
  "external-tools": { region: "meta", describes: "External GUI/tool attribution (t-327f81)" },
  harness: { region: "meta", describes: "Runs under a harness" },
  resume: { region: "meta", describes: "Resumable, or resumable-but-fresh-start (spec 221)" },
  fork: { region: "meta", describes: "This row is a forked sibling (spec 225)" },
  continuity: { region: "meta", describes: "Continuity brief freshness (spec 241)" },
  "persistence-hooks": { region: "meta", describes: "Runtime persistence hook health (spec 316)" },

  focus: { region: "footer", describes: "What the agent is working on (spec 390)" },
  "metrics-lanes": { region: "footer", describes: "Expanded CPU/memory lanes (spec 386)" },
  actions: { region: "footer", describes: "Inline actions and the overflow menu" },
};

/**
 * Components a template may not hide (fork 3, ratified). `verify` is here for its FAIL state only; the
 * re-admission phase 2 implements is per-row and per-state, not "always show verify".
 */
export const CRITICAL_CARD_COMPONENTS: readonly CardComponentId[] = CARD_COMPONENT_IDS.filter(
  (id) => CARD_CATALOG[id].critical === true,
);

export interface CardTemplate {
  readonly version: number;
  readonly header: readonly CardComponentId[];
  readonly meta: readonly CardComponentId[];
  readonly footer: readonly CardComponentId[];
}

/**
 * The card as it shipped, expressed in the catalog. The order is the order the renderer used before
 * this module existed — including the two rules the specs that introduced them made explicit:
 * `branch` is FIXED first among the meta badges (spec 384), and `sub` precedes the badge run.
 */
export const DEFAULT_CARD_TEMPLATE: CardTemplate = {
  version: CARD_TEMPLATE_VERSION,
  header: ["status-dot", "name", "model", "model-provenance", "metrics-pill"],
  meta: [
    "sub",
    "hidden-count",
    "branch",
    "config-invalid",
    "attention",
    "awaiting-human",
    "auth-required",
    "verify",
    "evidence",
    "external-tools",
    "harness",
    "resume",
    "fork",
    "continuity",
    "persistence-hooks",
  ],
  footer: ["focus", "metrics-lanes", "actions"],
};

export function isCardComponentId(value: string): value is CardComponentId {
  return (CARD_COMPONENT_IDS as readonly string[]).includes(value);
}

/** The ids a region lists, in template order. */
export function templateRegion(template: CardTemplate, region: CardRegion): readonly CardComponentId[] {
  return template[region];
}

/** Ids the region renders as siblings — inline members are rendered by their host, not by the region. */
export function topLevelComponents(template: CardTemplate, region: CardRegion): CardComponentId[] {
  return templateRegion(template, region).filter((id) => CARD_CATALOG[id].inlineWith === undefined);
}

/** Ids rendered inside `host`'s own element, in template order. */
export function inlineMembers(template: CardTemplate, host: CardComponentId): CardComponentId[] {
  return templateRegion(template, CARD_CATALOG[host].region).filter((id) => CARD_CATALOG[id].inlineWith === host);
}

/**
 * Which template a row renders through.
 *
 * The `configured` parameter has no producer in phase 1 — it is here because the V1 boundary the human
 * ratified ("agent cards only; terminal rows are out of scope") has to be a property of the RESOLVER,
 * not a habit of its callers. A terminal row takes the default whatever anyone configures, and
 * `test/unit/sidebarCardCatalog.test.ts` proves it before a configuration surface exists to violate it.
 */
export function resolveCardTemplate(row: Pick<AgentVM, "kind">, configured?: CardTemplate): CardTemplate {
  if (!configured) return DEFAULT_CARD_TEMPLATE;
  return isAgentRow(row) ? configured : DEFAULT_CARD_TEMPLATE;
}
