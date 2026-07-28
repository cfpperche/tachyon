import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import {
  CARD_OPTION_CATALOG,
  DEFAULT_CARD_TEMPLATE,
  parseCardTemplate,
  type CardTemplate,
} from "../../src/sidebar/cardTemplate.js";
import type { AgentVM } from "../../src/sidebar/types.js";

/**
 * `t-045d44` (SDD 479) — per-component options, which phase 2 refused by name rather than accept and
 * ignore. The two the ratified sketch shows are implemented here: `model.maxChars` and `focus.lines`.
 *
 * The rule that shapes every test below is phase 2's own: *accepting a key the card cannot act on is
 * a promise it does not keep.* So each option is asserted twice — the parser takes it, AND the card
 * visibly does something with it. A validation-only test would re-create exactly the state phase 2
 * declined to ship.
 *
 * The two are enforced in different places on purpose, per spec.md § narrow sidebar (truncation and
 * wrapping belong to the COMPONENT, not the template): `maxChars` is a renderer concern because the
 * tooltip must appear exactly when something was hidden, and `lines` is CSS because clamping is.
 */

const at = "settings.sidebar.cardTemplate";
const sketch = {
  version: 1,
  header: ["status-dot", "name", "model", "model-provenance", "metrics-pill"],
  meta: ["branch", "attention", "auth-required", "verify", "harness"],
  footer: ["focus", "metrics-lanes", "actions"],
  options: { model: { maxChars: 24 }, focus: { lines: 1 } },
};

describe("t-045d44 — parsing `options`", () => {
  it("accepts the ratified schema sketch verbatim", () => {
    // plan.md § 2's example is the contract's own worked example; if it does not parse, the schema
    // and the document that ratified it disagree.
    const result = parseCardTemplate(sketch, at);
    expect(result.errors).toEqual([]);
    expect(result.config?.base.options).toEqual({ model: { maxChars: 24 }, focus: { lines: 1 } });
  });

  it("refuses an unknown component under options, by name", () => {
    const result = parseCardTemplate({ ...sketch, options: { nonsense: { maxChars: 4 } } }, at);
    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("unknown component 'nonsense'");
  });

  it("distinguishes a real component that takes no options from one that does not exist", () => {
    // Both are refusals, but they are different mistakes and deserve different sentences: one is a
    // typo, the other is a reasonable belief about a component that happens to be wrong.
    const result = parseCardTemplate({ ...sketch, options: { branch: { maxChars: 4 } } }, at);
    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("'branch' takes no options");
    expect(result.errors.join("\n")).toContain("model, focus");
  });

  it("refuses an unknown option on a component that has some, listing what it accepts", () => {
    const result = parseCardTemplate({ ...sketch, options: { model: { maxChar: 24 } } }, at);
    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("unknown option 'maxChar'");
    expect(result.errors.join("\n")).toContain("allowed: maxChars");
  });

  it("refuses a value of the wrong type, naming what it got", () => {
    for (const [given, described] of [["24", "string"], [true, "boolean"], [null, "null"], [[24], "a list"], [2.5, "number"]] as const) {
      const result = parseCardTemplate({ ...sketch, options: { model: { maxChars: given } } }, at);
      expect(result.config, `maxChars: ${JSON.stringify(given)} was accepted`).toBeUndefined();
      expect(result.errors.join("\n")).toContain("must be a whole number");
      if (described !== "number") expect(result.errors.join("\n")).toContain(described);
    }
  });

  it("refuses a value outside the declared bounds instead of clamping it", () => {
    // Clamping would leave the file saying one thing and the card doing another, with nothing to tell
    // the person which won. The bound is part of the contract, so exceeding it is a refusal.
    const { min, max } = CARD_OPTION_CATALOG.model.maxChars;
    for (const given of [min - 1, max + 1, 0, -3]) {
      const result = parseCardTemplate({ ...sketch, options: { model: { maxChars: given } } }, at);
      expect(result.config, `maxChars: ${given} was accepted`).toBeUndefined();
      expect(result.errors.join("\n")).toContain(`outside ${min}–${max}`);
    }
    expect(parseCardTemplate({ ...sketch, options: { model: { maxChars: min } } }, at).errors).toEqual([]);
    expect(parseCardTemplate({ ...sketch, options: { model: { maxChars: max } } }, at).errors).toEqual([]);
  });

  it("refuses an option for a component this template does not render", () => {
    // Same precedent as an inline member with no host: a line that cannot do anything is likelier a
    // mistake than an intention, and silence would leave the person believing it took effect.
    const result = parseCardTemplate({ ...sketch, footer: ["actions"], options: { focus: { lines: 2 } } }, at);
    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("does not render 'focus'");
  });

  it("judges that against the RESOLVED template, not the keys this document wrote", () => {
    // A document that mentions no footer still renders `focus`, because silence inherits the base.
    // Validating against the written keys alone would refuse a perfectly good template.
    const result = parseCardTemplate({ version: 1, meta: ["branch"], options: { focus: { lines: 2 } } }, at);
    expect(result.errors).toEqual([]);
    expect(result.config?.base.options?.focus?.lines).toBe(2);
  });

  it("refuses the template WHOLE when only the options are wrong", () => {
    const result = parseCardTemplate({ ...sketch, options: { model: { maxChars: 0 } } }, at);
    expect(result.config, "a partially applied template is the one outcome the spec forbids").toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("inherits the base's options when a document is silent about them", () => {
    // The same rule the regions follow. A personal override that only reorders badges must not
    // quietly restore full-length model labels the project chose to shorten.
    const base: CardTemplate = { ...DEFAULT_CARD_TEMPLATE, options: { model: { maxChars: 12 } } };
    const result = parseCardTemplate({ version: 1, meta: ["branch"] }, at, base);
    expect(result.errors).toEqual([]);
    expect(result.config?.base.options?.model?.maxChars).toBe(12);
  });

  it("leaves the product default with no options at all", () => {
    // The phase-1 equality proof asserts an unconfigured workspace is byte-identical to the
    // pre-template card. A default option VALUE would be a behavior change dressed as a default.
    expect(DEFAULT_CARD_TEMPLATE.options).toBeUndefined();
  });
});

describe("t-045d44 — what the options actually do to a card", () => {
  let AgentRow: (props: unknown) => unknown;
  beforeAll(async () => {
    const mod = await loadWebviewModule(path.join(__dirname, "../../src/webview/sidebar/App.tsx"));
    AgentRow = mod.AgentRow as typeof AgentRow;
  }, 60_000);

  const LONG_MODEL = "claude-opus-4-5-20251101-preview";
  // Built the way test/fixtures/sidebar/agentCardFixtures.ts builds its rows — a minimal running agent
  // — rather than spreading a SAMPLE row, which carries fields these cases do not set up.
  const row = (over: Partial<AgentVM> = {}): AgentVM =>
    ({ status: "running", kind: "agent", name: "opt", model: LONG_MODEL, ...over }) as AgentVM;

  const render = (a: AgentVM, options?: CardTemplate["options"]): string =>
    renderStatic(
      AgentRow({
        a,
        flash: false,
        ...(options ? { cardTemplate: { base: { ...DEFAULT_CARD_TEMPLATE, options } } } : {}),
      }),
    );

  it("shortens the painted model label and keeps the full value in the tooltip", () => {
    const html = render(row(), { model: { maxChars: 10 } });
    expect(html).toContain("…");
    expect(html).not.toContain(`>${LONG_MODEL}<`);
    // The accessibility criterion the task names: a truncated identifier must stay recoverable.
    // Model names differ in their TAILS, so a clipped label can otherwise read as a different model.
    expect(html).toContain(`title="${LONG_MODEL}"`);
    const painted = /<span class="model"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? "";
    expect(painted.length).toBeLessThanOrEqual(10);
  });

  it("adds no tooltip when the label already fits — the title means 'something was hidden'", () => {
    const html = render(row({ model: "gpt-5" }), { model: { maxChars: 24 } });
    expect(html).toContain(">gpt-5<");
    expect(html).not.toContain('title="gpt-5"');
  });

  it("passes focus.lines to CSS as a custom property, and sets none when unconfigured", () => {
    const focus = { source: "task" as const, text: "a long focus line that would wrap", full: "a long focus line that would wrap", taskId: "t-000001" };
    expect(render(row({ focus }), { focus: { lines: 3 } })).toContain("--card-focus-lines:3");
    // Unconfigured must not emit the property at all: sidebar.css keys the multi-line rule off its
    // presence, so an empty or default-valued property would change every unconfigured card.
    expect(render(row({ focus }))).not.toContain("--card-focus-lines");
  });
});
