/**
 * SDD 479 phase 4 — the model behind the Control → Settings card-template block.
 *
 * Pure and UI-free on purpose: the block is a thin producer of the same data `tachyon.yml` carries, so
 * everything that can be decided without a DOM is decided here and tested without one.
 *
 * Why a composer instead of a YAML text box: `plan.md` rejected a drag-and-drop editor *as the first
 * deliverable* — "it presumes the schema is already right. If the YAML form proves itself, an editor
 * becomes a thin producer of the same data". Phases 2 and 3 shipped the YAML form and it held, so this
 * is that thin producer. It also means the block needs no YAML parser in the webview and validates
 * through `parseCardTemplate` — the SAME function the config loader calls — so the preview and the
 * loader cannot disagree about what is valid.
 */
import {
  CARD_CATALOG,
  CARD_REGIONS,
  CARD_TEMPLATE_VERSION,
  DEFAULT_CARD_TEMPLATE,
  parseCardTemplate,
  type CardComponentId,
  type CardRegion,
  type CardTemplate,
} from "../sidebar/cardTemplate.js";

/** One component in the composer: where it sits, and whether the template shows it. */
export interface CardEditorEntry {
  id: CardComponentId;
  /** what it shows, from the catalog — never re-worded here */
  describes: string;
  shown: boolean;
  /** a state a template may not hide; the card re-admits it (ratified fork 3) */
  critical: boolean;
  /** renders inside another component, so hiding the host hides it too */
  inlineWith?: CardComponentId;
}

/** The editable state: every catalog component, per region, in the order the card would render them. */
export type CardEditorState = Readonly<Record<CardRegion, readonly CardEditorEntry[]>>;

function entryOf(id: CardComponentId, shown: boolean): CardEditorEntry {
  const spec = CARD_CATALOG[id];
  return {
    id,
    describes: spec.describes,
    shown,
    critical: spec.critical === true,
    ...(spec.inlineWith ? { inlineWith: spec.inlineWith } : {}),
  };
}

/**
 * Build the editable state from a template. Components the template omits are listed too — hidden,
 * after the shown ones — because a person cannot bring back what the editor does not show them.
 */
export function editorStateFrom(template: CardTemplate = DEFAULT_CARD_TEMPLATE): CardEditorState {
  const state = {} as Record<CardRegion, CardEditorEntry[]>;
  for (const region of CARD_REGIONS) {
    const shown = template[region].filter((id) => CARD_CATALOG[id].region === region);
    const hidden = DEFAULT_CARD_TEMPLATE[region].filter((id) => !shown.includes(id));
    state[region] = [...shown.map((id) => entryOf(id, true)), ...hidden.map((id) => entryOf(id, false))];
  }
  return state;
}

/** The template the current state describes. Only shown components, in listed order. */
export function templateFrom(state: CardEditorState): CardTemplate {
  return {
    version: CARD_TEMPLATE_VERSION,
    header: state.header.filter((e) => e.shown).map((e) => e.id),
    meta: state.meta.filter((e) => e.shown).map((e) => e.id),
    footer: state.footer.filter((e) => e.shown).map((e) => e.id),
  };
}

/**
 * Show/hide one component.
 *
 * Hiding a host hides the components that render inside it, and showing an inline member shows its
 * host: the alternative is a template the validator would refuse ("'model-provenance' renders inside
 * 'model', which this template omits") for a reason the person never asked for. The editor keeps the
 * document valid by construction; `validate` is the backstop, not the mechanism.
 */
export function toggleComponent(state: CardEditorState, region: CardRegion, id: CardComponentId): CardEditorState {
  const entries = state[region];
  const target = entries.find((e) => e.id === id);
  if (!target) return state;
  const next = !target.shown;
  const hosts = new Set<CardComponentId>();
  for (let host = CARD_CATALOG[id].inlineWith; host; host = CARD_CATALOG[host].inlineWith) hosts.add(host);
  return {
    ...state,
    [region]: entries.map((entry) => {
      if (entry.id === id) return { ...entry, shown: next };
      // showing an inline member pulls its hosts in…
      if (next && hosts.has(entry.id)) return { ...entry, shown: true };
      // …and hiding a host drops whatever renders inside it
      if (!next && dependsOn(entry.id, id)) return { ...entry, shown: false };
      return entry;
    }),
  };
}

/** Does `id` render (transitively) inside `host`? */
function dependsOn(id: CardComponentId, host: CardComponentId): boolean {
  for (let cursor = CARD_CATALOG[id].inlineWith; cursor; cursor = CARD_CATALOG[cursor].inlineWith) {
    if (cursor === host) return true;
  }
  return false;
}

/** Move a component one place up or down within its region. Inline members travel with their host. */
export function moveComponent(
  state: CardEditorState,
  region: CardRegion,
  id: CardComponentId,
  direction: -1 | 1,
): CardEditorState {
  const entries = [...state[region]];
  const from = entries.findIndex((e) => e.id === id);
  if (from < 0) return state;
  const to = from + direction;
  if (to < 0 || to >= entries.length) return state;
  // An inline member may not be lifted out of its host's run: its position is the host's business.
  if (CARD_CATALOG[id].inlineWith || CARD_CATALOG[entries[to]!.id].inlineWith) return state;
  [entries[from], entries[to]] = [entries[to]!, entries[from]!];
  return { ...state, [region]: entries };
}

export interface CardEditorValidation {
  /** the template, when it is valid — the same object the preview renders */
  template?: CardTemplate;
  /** refusals from the SHARED validator, verbatim, so the block and the loader say the same thing */
  errors: string[];
}

/** Validate the composed template through the config loader's own validator. */
export function validate(state: CardEditorState): CardEditorValidation {
  const template = templateFrom(state);
  const parsed = parseCardTemplate(
    { version: template.version, header: [...template.header], meta: [...template.meta], footer: [...template.footer] },
    "settings.sidebar.cardTemplate",
  );
  return parsed.config ? { template: parsed.config.base, errors: [] } : { errors: parsed.errors };
}

/**
 * The YAML to paste into `tachyon.yml`.
 *
 * Emitted rather than written: this block composes a template and shows what it would say, and the
 * file stays the thing a person edits, reviews and commits. Only regions that DIFFER from the product
 * default are emitted — silence inherits (phase 2), so writing a region that matches the default would
 * pin it against future product changes for no reason the author intended.
 */
export function toYaml(state: CardEditorState): string {
  const template = templateFrom(state);
  const lines = ["settings:", "  sidebar:", "    cardTemplate:", `      version: ${CARD_TEMPLATE_VERSION}`];
  let changed = false;
  for (const region of CARD_REGIONS) {
    const ids = template[region];
    const isDefault =
      ids.length === DEFAULT_CARD_TEMPLATE[region].length &&
      ids.every((id, index) => id === DEFAULT_CARD_TEMPLATE[region][index]);
    if (isDefault) continue;
    changed = true;
    lines.push(`      ${region}: [${ids.join(", ")}]`);
  }
  // Nothing differs: say so in YAML that is still valid to paste, rather than emitting a bare version
  // block whose meaning ("everything default") a reader would have to infer.
  if (!changed) lines.push("      # every region matches the default card — nothing to override yet");
  return `${lines.join("\n")}\n`;
}

/**
 * SDD 479 phase 5 — the same template for the PERSONAL home; t-aaad95 moved that home from VS Code
 * settings to `sidebar.cardTemplate` in the global Tachyon settings file. Still JSON either way.
 *
 * The block emits for whichever home the person picked rather than making them hand-translate YAML
 * into settings.json — a translation step is where a working template becomes a refused one, and the
 * refusal would name a key they never typed.
 *
 * Same "only what differs" rule as `toYaml`, and for a sharper reason here: silence in a personal
 * override inherits the PROJECT's region (phase 5), so emitting a region that merely matches the
 * default would silently overrule a project template the author never looked at.
 */
export function toSettingsJson(state: CardEditorState): string {
  const template = templateFrom(state);
  const body: Record<string, unknown> = { version: CARD_TEMPLATE_VERSION };
  for (const region of CARD_REGIONS) {
    const ids = template[region];
    const isDefault =
      ids.length === DEFAULT_CARD_TEMPLATE[region].length &&
      ids.every((id, index) => id === DEFAULT_CARD_TEMPLATE[region][index]);
    if (!isDefault) body[region] = [...ids];
  }
  return `${JSON.stringify({ "tachyon.sidebar.cardTemplate": body }, null, 2)}\n`;
}
