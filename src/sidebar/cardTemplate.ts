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
import { SUPPORTED_AGENT_RUNTIME_NAMES } from "../agents/agentRuntimeAdmission.js";
import { isAgentRow, type AgentVM } from "./types.js";

/**
 * SDD 479 phase 3 — the runtime names a per-runtime override may key on: every runtime Tachyon can run
 * an Agent on. Borrowed, not redeclared, so a runtime added to the product is overridable the same day.
 */
const AGENT_RUNTIME_NAMES: readonly string[] = SUPPORTED_AGENT_RUNTIME_NAMES;

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

/**
 * `t-045d44` (SDD 479) — the closed per-component option set.
 *
 * Declared as data for the same reason `CARD_CATALOG` is: the validator, the error messages and the
 * settings surface all read ONE table, so a new option cannot be accepted by the parser while the
 * card ignores it — which is the promise phase 2 refused to make when it rejected `options` by name.
 *
 * Bounds are part of the contract, not defensive trimming. `maxChars: 0` would erase the label it is
 * meant to shorten, and an unbounded `lines` turns a compact row into a page; both are refusals with
 * a reason rather than a silently clamped value, because a clamp hides that the file says something
 * the product will not do.
 */
export interface CardOptionSpec {
  readonly kind: "integer";
  readonly min: number;
  readonly max: number;
  readonly describes: string;
}

export const CARD_OPTION_CATALOG = {
  model: {
    maxChars: {
      kind: "integer",
      min: 4,
      max: 200,
      describes: "Truncate the model label to at most this many characters (full value stays in the tooltip)",
    },
  },
  focus: {
    lines: {
      kind: "integer",
      min: 1,
      max: 5,
      describes: "How many lines the focus text may wrap to before it is clipped",
    },
  },
} as const satisfies Readonly<Partial<Record<CardComponentId, Readonly<Record<string, CardOptionSpec>>>>>;

/** Components that accept an option at all. Anything else under `options:` is refused by name. */
export type CardOptionComponentId = keyof typeof CARD_OPTION_CATALOG;

export interface CardTemplateOptions {
  readonly model?: { readonly maxChars: number };
  readonly focus?: { readonly lines: number };
}

export interface CardTemplate {
  readonly version: number;
  readonly header: readonly CardComponentId[];
  readonly meta: readonly CardComponentId[];
  readonly footer: readonly CardComponentId[];
  /**
   * Absent means every component renders as it always has. Omitted from `DEFAULT_CARD_TEMPLATE` on
   * purpose: the phase-1 equality proof asserts an unconfigured workspace is byte-identical to the
   * pre-template card, and a default option value would be a behavior change wearing a default's
   * clothes.
   */
  readonly options?: CardTemplateOptions;
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
export function resolveCardTemplate(
  row: Pick<AgentVM, "kind" | "runtime">,
  configured?: CardTemplateConfig,
): CardTemplate {
  return resolveCardTemplateFor(row, configured).template;
}

/**
 * SDD 479 phase 5 — the same lookup, answering both questions at once: which template this row
 * renders through, and which home wrote it.
 *
 * ONE function rather than a `resolveCardTemplate` beside a `resolveCardTemplateSource`, because two
 * functions walking the same precedence chain can drift — and a UI that names the wrong home is worse
 * than one that says nothing, since the human would then "fix" the file that was never in effect.
 */
export function resolveCardTemplateFor(
  row: Pick<AgentVM, "kind" | "runtime">,
  configured?: CardTemplateConfig,
): { template: CardTemplate; source: CardTemplateSource } {
  if (!configured) return { template: DEFAULT_CARD_TEMPLATE, source: "default" };
  // The ratified V1 boundary lives here, not in the callers: a terminal row takes the product default
  // whatever anyone configured, in either home.
  if (!isAgentRow(row)) return { template: DEFAULT_CARD_TEMPLATE, source: "default" };
  // SDD 479 phase 3 — a runtime override wins for the rows that report that runtime; every other row
  // takes the base. The fallback is explicit BECAUSE it is a lookup miss and nothing else: there is
  // no partial merge here, since overrides were resolved whole at parse time.
  const override = row.runtime ? configured.runtimes?.[row.runtime] : undefined;
  if (override && row.runtime) {
    return { template: override, source: configured.sources?.runtimes?.[row.runtime] ?? configured.sources?.base ?? "project" };
  }
  return { template: configured.base, source: configured.sources?.base ?? "project" };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * SDD 479 phase 2 — authoring a template
 * ──────────────────────────────────────────────────────────────────────────────────────────────*/

/** Top-level keys a written template may carry. Anything else is refused BY NAME. */
const TEMPLATE_KEYS = ["version", ...CARD_REGIONS, "runtimes", "options"] as const;

/** Keys a per-runtime override may carry. `extends` is REQUIRED — see `CardTemplateInheritance`. */
const OVERRIDE_KEYS = ["extends", ...CARD_REGIONS] as const;

/**
 * SDD 479 phase 3, ratified fork 2 — an override states its own inheritance; the product never guesses.
 *
 * - `default` — layer this override's regions onto the template the row would otherwise use (the
 *   project's, which is itself the product default plus the project's changes). Regions the override
 *   does not mention keep what that base says, so a new element the product adds later still appears.
 * - `replace` — no inheritance: the override IS the template. Because "exactly as written" would
 *   otherwise mean "a card with no name and no actions" for anyone who wrote only `meta:`, a `replace`
 *   override must list ALL THREE regions; a partial one is refused by name.
 *
 * The ratified text ("`extends: default` or `replace`") did not say what the base of `default` is.
 * It is the PROJECT template rather than the bare product default, so the three layers compose —
 * product → project → runtime — and one runtime's override never silently discards what the project
 * decided for every other row. Recorded as a phase-3 refinement in `spec.md`.
 */
export type CardTemplateInheritance = "default" | "replace";
const INHERITANCE_VALUES: readonly CardTemplateInheritance[] = ["default", "replace"];

/**
 * SDD 479 phase 5 — where a template in effect came from. Ratified fork 1: the project default lives
 * in `tachyon.yml` and travels with the repo; an optional personal override lives in the global
 * Tachyon settings file (t-aaad95; VS Code settings before)
 * and WINS. This enum exists so the UI can SAY which one a row is using — the fork's own wording made
 * that sentence part of the feature, and the reason is concrete: a personal override quietly
 * contradicting the project's template is otherwise indistinguishable from a broken project template.
 */
export type CardTemplateSource = "default" | "project" | "personal";

/** Which home produced each resolved template. Parallel to the templates themselves, key for key. */
export interface CardTemplateSources {
  readonly base: CardTemplateSource;
  readonly runtimes?: Readonly<Record<string, CardTemplateSource>>;
}

/**
 * A full card configuration: the template every agent row uses, plus any per-runtime override.
 * Overrides are resolved to COMPLETE templates at parse time, so the renderer does a lookup and never
 * a merge — the wire carries no inheritance to re-interpret, and the strict schema validates concrete
 * templates.
 */
export interface CardTemplateConfig {
  /** the template in effect — the product default when nothing was written */
  readonly base: CardTemplate;
  /** resolved per-runtime templates, keyed by the runtime name a row reports */
  readonly runtimes?: Readonly<Record<string, CardTemplate>>;
  /**
   * SDD 479 phase 5 — provenance for the statement the settings surface owes the human. Optional
   * because every phase-2/3 producer predates it and the engine wire never carries it: the personal
   * layer is a SHELL concern (one person, one machine — the channel `sortPrefs` already uses), so it
   * is attached where the two layers actually meet. Absent means "nobody claimed a source", and the
   * UI says nothing rather than guessing.
   */
  readonly sources?: CardTemplateSources;
}

export interface CardTemplateParseResult {
  /** present only when the document is valid IN FULL — there is no partially applied template */
  config?: CardTemplateConfig;
  /** every problem found, each naming the offending key; empty iff `config` is present */
  errors: string[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the region lists of one template document (the project's, or one override's). Returns only
 * the regions that were MENTIONED, so each caller can apply its own inheritance rule to the rest.
 */
function parseRegions(
  raw: Record<string, unknown>,
  keyPath: string,
  errors: string[],
): Partial<Record<CardRegion, CardComponentId[]>> {
  const regions: Partial<Record<CardRegion, CardComponentId[]>> = {};
  for (const region of CARD_REGIONS) {
    const value = raw[region];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(`${keyPath}.${region}: must be a list of component ids`);
      continue;
    }
    const ids: CardComponentId[] = [];
    for (const [index, entry] of value.entries()) {
      const at = `${keyPath}.${region}[${index}]`;
      if (typeof entry !== "string") {
        errors.push(`${at}: must be a component id (a string), not ${Array.isArray(entry) ? "a list" : typeof entry}`);
        continue;
      }
      if (!isCardComponentId(entry)) {
        errors.push(`${at}: unknown component '${entry}' — the catalog is ${CARD_COMPONENT_IDS.join(", ")}`);
        continue;
      }
      if (CARD_CATALOG[entry].region !== region) {
        errors.push(`${at}: '${entry}' belongs to the ${CARD_CATALOG[entry].region} region, not ${region}`);
        continue;
      }
      if (ids.includes(entry)) {
        errors.push(`${at}: duplicate component '${entry}' in the ${region} region`);
        continue;
      }
      ids.push(entry);
    }
    regions[region] = ids;
  }

  // An inline member with no host can never render; saying so beats shipping a line that does nothing.
  for (const region of CARD_REGIONS) {
    const ids = regions[region];
    if (!ids) continue;
    for (const id of ids) {
      const host = CARD_CATALOG[id].inlineWith;
      if (host && !ids.includes(host)) {
        errors.push(
          `${keyPath}.${region}: '${id}' renders inside '${host}', which this template omits — list '${host}' too, or drop '${id}'`,
        );
      }
    }
  }
  return regions;
}

/**
 * `t-045d44` — validate `options:`, fail-closed and by name.
 *
 * `effective` is the template the regions resolved to, NOT the keys the document happened to write:
 * a region left silent inherits `base`, so `model` can be present without appearing in this file.
 * Validating against the written keys would refuse a perfectly good template.
 *
 * An option for a component the template does NOT render is refused, following the precedent
 * `parseRegions` already set for an inline member with no host: a line that cannot do anything is
 * more likely a mistake than an intention, and saying so beats shipping silence.
 */
function parseOptions(
  raw: unknown,
  keyPath: string,
  effective: readonly CardComponentId[],
  errors: string[],
): CardTemplateOptions | undefined {
  if (raw === undefined) return undefined;
  if (!isMapping(raw)) {
    errors.push(`${keyPath}: must be a mapping of component id to its options (allowed: ${Object.keys(CARD_OPTION_CATALOG).join(", ")})`);
    return undefined;
  }

  const out: Record<string, Record<string, number>> = {};
  for (const [component, value] of Object.entries(raw)) {
    const specs = (CARD_OPTION_CATALOG as Readonly<Record<string, Readonly<Record<string, CardOptionSpec>>>>)[component];
    if (!specs) {
      const known = isCardComponentId(component)
        ? `'${component}' takes no options — these do: ${Object.keys(CARD_OPTION_CATALOG).join(", ")}`
        : `unknown component '${component}' — these take options: ${Object.keys(CARD_OPTION_CATALOG).join(", ")}`;
      errors.push(`${keyPath}: ${known}`);
      continue;
    }
    if (!effective.includes(component as CardComponentId)) {
      errors.push(`${keyPath}.${component}: this template does not render '${component}', so its options would do nothing`);
      continue;
    }
    if (!isMapping(value)) {
      errors.push(`${keyPath}.${component}: must be a mapping of option to value (allowed: ${Object.keys(specs).join(", ")})`);
      continue;
    }
    const resolved: Record<string, number> = {};
    for (const [option, given] of Object.entries(value)) {
      const spec = specs[option];
      if (!spec) {
        errors.push(`${keyPath}.${component}: unknown option '${option}' (allowed: ${Object.keys(specs).join(", ")})`);
        continue;
      }
      if (typeof given !== "number" || !Number.isInteger(given)) {
        errors.push(
          `${keyPath}.${component}.${option}: must be a whole number, not ${Array.isArray(given) ? "a list" : given === null ? "null" : typeof given}`,
        );
        continue;
      }
      if (given < spec.min || given > spec.max) {
        // Refused rather than clamped: a clamp would hide that the file asks for something the card
        // will not do, and the person would keep believing the written value is in effect.
        errors.push(`${keyPath}.${component}.${option}: ${given} is outside ${spec.min}–${spec.max}`);
        continue;
      }
      resolved[option] = given;
    }
    if (Object.keys(resolved).length > 0) out[component] = resolved;
  }
  return Object.keys(out).length > 0 ? (out as CardTemplateOptions) : undefined;
}

/**
 * Validate a written card template. Pure and framework-agnostic so that **one** validator serves every
 * home the template can have — `tachyon.yml` and the global Tachyon settings file. Two validators that
 * can disagree about the same document is the failure this avoids.
 *
 * Fail-closed, and whole: on any error the caller gets `errors` and NO template, because a
 * partially-applied layout is the one outcome the spec forbids outright. Errors accumulate rather than
 * throw, so a person fixing their file sees every problem at once instead of one per save.
 *
 * A region a template does not mention takes `base` for that region — the product default for the
 * project's own template, and the PROJECT's template for a personal override (phase 5), so the three
 * layers compose product → project → person. An explicitly empty list (`meta: []`) means "hide them
 * all" and is honored — critical re-admission still applies. The asymmetry is deliberate: silence
 * should not delete the actions row from someone who only wanted to reorder badges, but a person who
 * writes `[]` has said what they mean.
 *
 * `base` is what makes the personal layer need no `extends` switch of its own: silence inherits, and
 * a person who genuinely wants to discard the project's layout writes all three regions — which IS
 * "replace", spelled out. Phase 3's runtime overrides still declare theirs, because there the two
 * readings are both useful and the ratified fork said the product must not guess.
 */
export function parseCardTemplate(
  raw: unknown,
  keyPath = "settings.sidebar.cardTemplate",
  base: CardTemplate = DEFAULT_CARD_TEMPLATE,
): CardTemplateParseResult {
  const errors: string[] = [];
  if (!isMapping(raw)) {
    return { errors: [`${keyPath}: must be a mapping with 'version' and any of ${CARD_REGIONS.join(", ")}`] };
  }

  for (const key of Object.keys(raw)) {
    if (!(TEMPLATE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${keyPath}: unknown key '${key}' (allowed: ${TEMPLATE_KEYS.join(", ")})`);
    }
  }

  if (raw.version === undefined) {
    errors.push(`${keyPath}.version: required (this Tachyon understands version ${CARD_TEMPLATE_VERSION})`);
  } else if (raw.version !== CARD_TEMPLATE_VERSION) {
    // Refused, never guessed: a template written for a schema this build does not implement can only
    // be honored by inventing what its author meant.
    errors.push(
      `${keyPath}.version: unknown template version ${JSON.stringify(raw.version)} (this Tachyon understands version ${CARD_TEMPLATE_VERSION})`,
    );
  }

  const regions = parseRegions(raw, keyPath, errors);
  const resolvedRegions = {
    header: regions.header ?? base.header,
    meta: regions.meta ?? base.meta,
    footer: regions.footer ?? base.footer,
  };
  // t-045d44 — a silent `options:` inherits `base`'s, the same rule the regions above follow, so a
  // personal override that only reorders badges keeps the project's truncation instead of quietly
  // restoring full-length labels.
  const options = raw.options === undefined
    ? base.options
    : parseOptions(raw.options, `${keyPath}.options`, [...resolvedRegions.header, ...resolvedRegions.meta, ...resolvedRegions.footer], errors);
  const parsed: CardTemplate = {
    version: CARD_TEMPLATE_VERSION,
    ...resolvedRegions,
    ...(options ? { options } : {}),
  };

  const runtimes = parseRuntimeOverrides(raw.runtimes, `${keyPath}.runtimes`, parsed, errors);

  if (errors.length > 0) return { errors };
  return {
    config: { base: parsed, ...(runtimes && Object.keys(runtimes).length > 0 ? { runtimes } : {}) },
    errors: [],
  };
}

/**
 * SDD 479 phase 5 — the two homes meeting, with precedence recorded rather than implied.
 *
 * Ratified fork 1: **personal wins**. What "wins" means is settled at PARSE time, not here — the
 * personal document was validated against the project's template as its base, so a region it does not
 * mention already carries the project's choice. By the time both arrive, each side is a complete
 * template and this is a lookup table, not a merge with rules of its own.
 *
 * Per-runtime keys merge key by key rather than wholesale: someone who overrides `claude` personally
 * has said nothing about the project's `codex` override, and dropping it would be the product
 * inventing an opinion the person never expressed.
 */
export function mergeCardTemplateConfigs(
  project: CardTemplateConfig | undefined,
  personal: CardTemplateConfig | undefined,
): CardTemplateConfig | undefined {
  if (!personal) {
    if (!project) return undefined;
    return { ...project, sources: { base: "project", ...(project.runtimes ? { runtimes: mapSources(project.runtimes, "project") } : {}) } };
  }
  const runtimes = { ...(project?.runtimes ?? {}), ...(personal.runtimes ?? {}) };
  const runtimeSources: Record<string, CardTemplateSource> = {
    ...mapSources(project?.runtimes ?? {}, "project"),
    ...mapSources(personal.runtimes ?? {}, "personal"),
  };
  return {
    base: personal.base,
    ...(Object.keys(runtimes).length > 0 ? { runtimes } : {}),
    sources: {
      base: "personal",
      ...(Object.keys(runtimeSources).length > 0 ? { runtimes: runtimeSources } : {}),
    },
  };
}

function mapSources(runtimes: Readonly<Record<string, CardTemplate>>, source: CardTemplateSource): Record<string, CardTemplateSource> {
  return Object.fromEntries(Object.keys(runtimes).map((runtime) => [runtime, source]));
}

/** The sentence the UI shows. Kept beside the resolution it describes so the two cannot drift apart. */
export function describeCardTemplateSource(source: CardTemplateSource): string {
  switch (source) {
    case "personal":
      return "your Tachyon settings file (personal override — wins over the project)";
    case "project":
      return "this project's tachyon.yml";
    default:
      return "Tachyon's default card";
  }
}

/**
 * SDD 479 phase 3 — per-runtime overrides, each resolved to a COMPLETE template.
 *
 * A key must name a runtime that can actually operate an Agent. That list is
 * `SUPPORTED_AGENT_RUNTIME_NAMES`, not the narrower attested four: a declared agent is attested,
 * but an ad-hoc one may be OpenCode/Gemini/Qwen/Hermes, and refusing `opencode:` would refuse an
 * override for rows this product creates. It is still the product's own list, not one invented here.
 */
function parseRuntimeOverrides(
  raw: unknown,
  keyPath: string,
  base: CardTemplate,
  errors: string[],
): Record<string, CardTemplate> | undefined {
  if (raw === undefined) return undefined;
  if (!isMapping(raw)) {
    errors.push(`${keyPath}: must be a mapping of runtime name to override`);
    return undefined;
  }
  const out: Record<string, CardTemplate> = {};
  for (const [runtime, value] of Object.entries(raw)) {
    const at = `${keyPath}.${runtime}`;
    if (!AGENT_RUNTIME_NAMES.includes(runtime)) {
      errors.push(`${at}: unknown runtime '${runtime}' — Tachyon runs agents on ${AGENT_RUNTIME_NAMES.join(", ")}`);
      continue;
    }
    if (!isMapping(value)) {
      errors.push(`${at}: must be a mapping with 'extends' and any of ${CARD_REGIONS.join(", ")}`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) {
        errors.push(`${at}: unknown key '${key}' (allowed: ${OVERRIDE_KEYS.join(", ")})`);
      }
    }

    const inheritance = value.extends;
    if (inheritance === undefined) {
      errors.push(
        `${at}.extends: required — say 'default' to layer onto the project's card, or 'replace' to write this runtime's card in full`,
      );
    } else if (typeof inheritance !== "string" || !INHERITANCE_VALUES.includes(inheritance as CardTemplateInheritance)) {
      errors.push(`${at}.extends: must be 'default' or 'replace', not ${JSON.stringify(inheritance)}`);
    }

    const regions = parseRegions(value, at, errors);

    if (inheritance === "replace") {
      // "Exactly as written" has to be written in full, or it silently means "a card with no name and
      // no actions" for anyone who only wanted to change the badges.
      const missing = CARD_REGIONS.filter((region) => regions[region] === undefined);
      if (missing.length > 0) {
        errors.push(
          `${at}: 'extends: replace' inherits nothing, so it must list every region — missing ${missing.join(", ")}. Use 'extends: default' to change only some.`,
        );
      }
    }
    if (inheritance !== "default" && inheritance !== "replace") continue;

    // `default` layers onto the project's template; `replace` stands alone (and is complete by now).
    const from = inheritance === "default" ? base : undefined;
    out[runtime] = {
      version: CARD_TEMPLATE_VERSION,
      header: regions.header ?? from?.header ?? [],
      meta: regions.meta ?? from?.meta ?? [],
      footer: regions.footer ?? from?.footer ?? [],
    };
  }
  return out;
}

/** Is this critical component's state ACTIVE on this row? Re-admission is per row and per state. */
export function criticalComponentActive(id: CardComponentId, row: AgentVM): boolean {
  switch (id) {
    case "config-invalid": return !!row.configInvalid;
    case "awaiting-human": return !!row.awaitingHuman;
    case "auth-required": return !!row.authRequired;
    // `verify` is critical for its FAIL state only — a passing or stale gate is information, not an
    // emergency, and re-admitting those would make "critical" mean "always shown".
    case "verify": return row.verify === "fail";
    default: return false;
  }
}

/**
 * Components the template omits that this row's state re-admits (ratified fork 3).
 *
 * The product overrides the person here, and only here. Someone who hides "auth required" to get a
 * tidy card would otherwise end up staring at an idle agent that cannot run — a preference silently
 * costing them the one signal that explains the silence. Re-admitted components render at the END of
 * the meta region, so a curated layout keeps its shape and the emergency is still on the card.
 */
export function readmittedCriticalComponents(template: CardTemplate, row: AgentVM): CardComponentId[] {
  if (!isAgentRow(row)) return [];
  return CRITICAL_CARD_COMPONENTS.filter((id) => !template.meta.includes(id) && criticalComponentActive(id, row));
}
