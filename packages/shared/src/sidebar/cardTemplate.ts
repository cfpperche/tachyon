/**
 * The sidebar agent card's closed component catalog and its one layout.
 *
 * The catalog is closed: `CardComponentId` is derived from `CARD_COMPONENT_IDS`, and the renderer
 * map in the webview is a `Record<CardComponentId, …>` — an id with no renderer, or a renderer with
 * no id, fails to compile.
 *
 * `DEFAULT_CARD_TEMPLATE` IS the card. Order here is the order the renderer paints — including the
 * two rules the specs that introduced them made explicit: `branch` is FIXED first among the meta
 * badges (spec 384), and `sub` precedes the badge run. `checklist` lives in the footer
 * (`t-281339`).
 *
 * Framework-agnostic on purpose (same contract as `types.ts`): no preact, no vscode. The webview
 * owns the fragments; this module owns which fragments exist, where they sit, and in what order.
 */

/** Bumped when the template SHAPE changes. */
export const CARD_TEMPLATE_VERSION = 1;

/**
 * The three fixed regions of a card. A flat ordered list per region — no nesting, no columns, no
 * conditionals. Regions map to the row's existing structural elements (`.row-top`, `.row-meta`,
 * and the trailing focus/detail/actions block).
 */
export const CARD_REGIONS = ["header", "meta", "footer"] as const;
export type CardRegion = (typeof CARD_REGIONS)[number];

/**
 * Every component a card can show. Derived from `AgentVM` — a component exists because a field
 * exists, never the other way round.
 *
 * NOT in the catalog, on purpose: the disclosure toggle / gutter spacer. It is tree chrome (it
 * reveals child ROWS, not a property of this agent), and hiding it would make collapsed children
 * unreachable. It stays structural, rendered before the header region.
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
  "refused",
  "attention",
  "awaiting-human",
  "auth-required",
  "evidence",
  "external-tools",
  "harness",
  "resume",
  "fork",
  "persistence-hooks",
  // footer
  "focus",
  "checklist",
  "metrics-lanes",
  "actions",
] as const;

export type CardComponentId = (typeof CARD_COMPONENT_IDS)[number];

export interface CardComponentSpec {
  /** the only region this component may appear in */
  readonly region: CardRegion;
  /**
   * Rendered INSIDE the named component's own element rather than as a sibling in the region, and
   * only when that component renders. The card has two such runs — `model` and `model-provenance`
   * live inside `.name`, where the sidebar's CSS and its reading order expect them — and they are
   * declared by the CATALOG, not by a template: the layout stays a flat ordered list.
   */
  readonly inlineWith?: CardComponentId;
}

export const CARD_CATALOG: Readonly<Record<CardComponentId, CardComponentSpec>> = {
  "status-dot": { region: "header" },
  name: { region: "header" },
  model: { region: "header", inlineWith: "name" },
  "model-provenance": { region: "header", inlineWith: "model" },
  "metrics-pill": { region: "header" },

  sub: { region: "meta" },
  "hidden-count": { region: "meta" },
  branch: { region: "meta" },
  "config-invalid": { region: "meta" },
  // t-0ad300 — the row exists ONLY to say this. The badge is always in the layout.
  refused: { region: "meta" },
  attention: { region: "meta" },
  "awaiting-human": { region: "meta" },
  "auth-required": { region: "meta" },
  evidence: { region: "meta" },
  "external-tools": { region: "meta" },
  harness: { region: "meta" },
  resume: { region: "meta" },
  fork: { region: "meta" },
  "persistence-hooks": { region: "meta" },

  focus: { region: "footer" },
  checklist: { region: "footer" },
  "metrics-lanes": { region: "footer" },
  actions: { region: "footer" },
};

export interface CardTemplate {
  readonly version: number;
  readonly header: readonly CardComponentId[];
  readonly meta: readonly CardComponentId[];
  readonly footer: readonly CardComponentId[];
}

/**
 * The card. The order is the order the renderer used before a catalog existed.
 */
export const DEFAULT_CARD_TEMPLATE: CardTemplate = {
  version: CARD_TEMPLATE_VERSION,
  header: ["status-dot", "name", "model", "model-provenance", "metrics-pill"],
  meta: [
    "sub",
    "hidden-count",
    "branch",
    "config-invalid",
    "refused",
    "attention",
    "awaiting-human",
    "auth-required",
    "evidence",
    "external-tools",
    "harness",
    "resume",
    "fork",
    "persistence-hooks",
  ],
  footer: ["focus", "checklist", "metrics-lanes", "actions"],
};

export function isCardComponentId(value: string): value is CardComponentId {
  return (CARD_COMPONENT_IDS as readonly string[]).includes(value);
}

/** The ids a region lists, in layout order. */
export function templateRegion(template: CardTemplate, region: CardRegion): readonly CardComponentId[] {
  return template[region];
}

/** Ids the region renders as siblings — inline members are rendered by their host, not by the region. */
export function topLevelComponents(template: CardTemplate, region: CardRegion): CardComponentId[] {
  return templateRegion(template, region).filter((id) => CARD_CATALOG[id].inlineWith === undefined);
}

/** Ids rendered inside `host`'s own element, in layout order. */
export function inlineMembers(template: CardTemplate, host: CardComponentId): CardComponentId[] {
  return templateRegion(template, CARD_CATALOG[host].region).filter((id) => CARD_CATALOG[id].inlineWith === host);
}
