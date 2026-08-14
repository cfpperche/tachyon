import { describe, expect, it } from "vitest";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { parseGlobalSettings } from "@tachyon/engine/config/globalSettings.js";
import {
  editorStateFrom,
  moveComponent,
  templateFrom,
  toSettingsJson,
  toYaml,
  toggleComponent,
  validate,
} from "../../src/webview/shared/control/cardTemplateEditor.js";
import {
  CARD_COMPONENT_IDS,
  CARD_REGIONS,
  DEFAULT_CARD_TEMPLATE,
  parseCardTemplate,
  type CardComponentId,
} from "@tachyon/shared/sidebar/cardTemplate.js";
import { CARD_PREVIEW_ROWS, CARD_PREVIEW_WIDTHS } from "../../src/sidebar/cardPreviewRows.js";

/**
 * SDD 479 phase 4 — the composer behind the Settings block.
 *
 * The property that matters most is the LAST test in this file: whatever the block shows you to paste,
 * pasted into `tachyon.yml`, produces the template the block was previewing. A preview that can
 * disagree with the file is the failure this design exists to avoid, and it would be invisible in a
 * screenshot.
 */
describe("SDD 479 phase 4 — the card template composer", () => {
  it("starts from the default card with every component visible", () => {
    const state = editorStateFrom();
    expect(templateFrom(state)).toEqual(DEFAULT_CARD_TEMPLATE);
    const listed = CARD_REGIONS.flatMap((region) => state[region].map((e) => e.id));
    expect([...listed].sort()).toEqual([...CARD_COMPONENT_IDS].sort());
  });

  it("lists a hidden component too, so it can be brought back", () => {
    const state = editorStateFrom({ ...DEFAULT_CARD_TEMPLATE, meta: ["branch"] });
    const meta = state.meta;
    expect(meta.find((e) => e.id === "branch")?.shown).toBe(true);
    expect(meta.find((e) => e.id === "harness")?.shown).toBe(false);
    // hidden ones still appear in the editor, after the shown ones
    expect(meta.map((e) => e.id)).toContain("harness");
    expect(meta.findIndex((e) => e.id === "branch")).toBeLessThan(meta.findIndex((e) => e.id === "harness"));
  });

  it("hides what renders inside a component when that component is hidden", () => {
    // `model` hosts `model-provenance`; hiding the host must not leave an unrenderable line behind —
    // that is exactly the template the validator refuses.
    const hidden = toggleComponent(editorStateFrom(), "header", "model");
    expect(hidden.header.find((e) => e.id === "model")?.shown).toBe(false);
    expect(hidden.header.find((e) => e.id === "model-provenance")?.shown).toBe(false);
    expect(validate(hidden).errors).toEqual([]);
  });

  it("brings the host back when an inline member is shown", () => {
    const withoutModel = toggleComponent(editorStateFrom(), "header", "model");
    const back = toggleComponent(withoutModel, "header", "model-provenance");
    expect(back.header.find((e) => e.id === "model")?.shown).toBe(true);
    expect(back.header.find((e) => e.id === "model-provenance")?.shown).toBe(true);
    expect(validate(back).errors).toEqual([]);
  });

  it("reorders within a region, and refuses to lift an inline member out of its host's run", () => {
    const moved = moveComponent(editorStateFrom(), "meta", "branch", -1);
    expect(templateFrom(moved).meta.slice(0, 3)).toEqual(["sub", "branch", "hidden-count"]);
    // `model-provenance` is inline; its position belongs to `model`
    const state = editorStateFrom();
    expect(moveComponent(state, "header", "model-provenance", -1)).toBe(state);
    // and nothing may be swapped INTO an inline slot either
    expect(moveComponent(state, "header", "model", 1)).toBe(state);
  });

  it("keeps the composed template valid through the shared validator at every step", () => {
    // Hide whatever is still shown, re-reading the state each time: hiding a host also hides what
    // renders inside it, so a loop over the ORIGINAL entries would toggle an already-hidden member
    // back ON (and drag its host with it). The invariant under test is that no reachable state is
    // invalid — not that a fixed sequence of clicks ends empty.
    let state = editorStateFrom();
    let guard = 0;
    for (;;) {
      const next = CARD_REGIONS.flatMap((region) => state[region].filter((e) => e.shown).map((e) => ({ region, id: e.id })))[0];
      if (!next || guard++ > CARD_COMPONENT_IDS.length * 2) break;
      state = toggleComponent(state, next.region, next.id);
      expect(validate(state).errors, `hiding ${next.id} produced an invalid template`).toEqual([]);
    }
    // everything off: still a valid document (critical states are re-admitted by the CARD, not here)
    expect(templateFrom(state)).toEqual({ version: 1, header: [], meta: [], footer: [] });
  });

  it("emits only what differs from the default — silence inherits, so writing it back would over-pin", () => {
    const untouched = toYaml(editorStateFrom());
    expect(untouched).toContain("version: 1");
    expect(untouched).toContain("nothing to override yet");
    expect(untouched).not.toContain("meta:");

    const edited = toYaml(toggleComponent(editorStateFrom(), "meta", "harness"));
    expect(edited).toContain("meta: [");
    expect(edited).not.toContain("harness");
    // header and footer are untouched, so they are not written
    expect(edited).not.toContain("header:");
    expect(edited).not.toContain("footer:");
  });

  it("emits YAML that tachyon.yml reads back as the very template the block previewed", () => {
    // The load-bearing round trip: composer → YAML → the real config loader → the same template.
    let state = editorStateFrom();
    state = toggleComponent(state, "meta", "harness");
    state = toggleComponent(state, "meta", "evidence");
    state = moveComponent(state, "meta", "branch", -1);
    state = toggleComponent(state, "footer", "metrics-lanes");

    const previewed = validate(state).template!;
    const result = parseConfig(`terminals:\n  dev:\n    cmd: bash\n${toYaml(state)}`);

    expect(result.errors).toEqual([]);
    expect(result.config?.settings.sidebar?.cardTemplateRefusal).toBeUndefined();
    expect(result.config?.settings.sidebar?.cardTemplate?.base).toEqual(previewed);
  });

  it("is validated by the loader's own function, not a copy of its rules", () => {
    // If these two ever diverge, the block would approve a template the file refuses.
    const state = toggleComponent(editorStateFrom(), "meta", "branch");
    const direct = parseCardTemplate({ ...templateFrom(state), header: [...templateFrom(state).header], meta: [...templateFrom(state).meta], footer: [...templateFrom(state).footer] });
    expect(validate(state).template).toEqual(direct.config?.base);
  });
});

describe("SDD 479 phase 4 — the rows the preview shows", () => {
  it("covers the states the spec names", () => {
    const ids = CARD_PREVIEW_ROWS.map((r) => r.id);
    expect(ids).toEqual(["healthy", "attention", "error", "no-model", "long"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is made of agent rows — a template never reaches a terminal, so previewing one would mislead", () => {
    for (const { row } of CARD_PREVIEW_ROWS) expect(row.kind).toBe("agent");
  });

  it("includes a row carrying states a template may not hide, so re-admission is visible", () => {
    const error = CARD_PREVIEW_ROWS.find((r) => r.id === "error")!.row;
    expect(error.authRequired).toBeDefined();
    expect(error.configInvalid).toBe(true);
  });

  it("previews at the sidebar's real width and at its narrowest", () => {
    expect(CARD_PREVIEW_WIDTHS.map((w) => w.px)).toEqual([320, 220]);
  });
});

/**
 * t-aaad95 — the personal home moved from a VS Code settings key to the global Tachyon settings file,
 * and this block's "Copy JSON" is what a person actually pastes there.
 *
 * There was NO test on this payload, which is how it kept emitting the flat `tachyon.sidebar.*` key
 * after that key stopped existing: Control would have handed someone a snippet the loader refuses as
 * an unknown key, naming a key Control itself told them to paste. So the assertion that matters is
 * not the shape in the abstract — it is that the real parser ACCEPTS what this emits.
 */
describe("the personal-home JSON Control tells you to paste", () => {
  const stateWith = (meta: readonly CardComponentId[]) => {
    let state = editorStateFrom(undefined);
    for (const id of DEFAULT_CARD_TEMPLATE.meta) state = toggleComponent(state, "meta", id);
    for (const id of meta) state = toggleComponent(state, "meta", id);
    return state;
  };

  it("is accepted verbatim by the global settings parser", () => {
    const emitted = JSON.parse(toSettingsJson(stateWith(["harness"])));
    const parsed = parseGlobalSettings(emitted, "settings.json");
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings?.sidebarCardTemplate).toBeDefined();
  });

  it("nests under sidebar.cardTemplate rather than the retired flat key", () => {
    const emitted = JSON.parse(toSettingsJson(stateWith(["harness"]))) as Record<string, unknown>;
    expect(Object.keys(emitted).sort()).toEqual(["sidebar", "version"]);
    expect((emitted.sidebar as Record<string, unknown>).cardTemplate).toMatchObject({ meta: ["harness"] });
  });

  it("still emits only what differs, so a silent region keeps the project's choice", () => {
    const untouched = JSON.parse(toSettingsJson(editorStateFrom(undefined))) as { sidebar: { cardTemplate: Record<string, unknown> } };
    expect(Object.keys(untouched.sidebar.cardTemplate)).toEqual(["version"]);
  });
});
