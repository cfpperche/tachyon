import { describe, expect, it } from "vitest";
import {
  DEFAULT_CARD_TEMPLATE,
  CARD_TEMPLATE_VERSION,
  describeCardTemplateSource,
  mergeCardTemplateConfigs,
  parseCardTemplate,
  resolveCardTemplateFor,
  resolveCardTemplate,
  type CardTemplateConfig,
} from "../../src/sidebar/cardTemplate.js";
import type { AgentVM } from "../../src/sidebar/types.js";

/**
 * SDD 479 phase 5 — the personal override (ratified fork 1).
 *
 * "Project default in tachyon.yml, optional personal override in VS Code settings, personal wins, and
 * the settings UI says which one is in effect." Three things follow, and each is proven here rather
 * than left to the reader of two files:
 *
 *  1. ONE validator serves both homes. A second one that could disagree is the failure this phase was
 *     written to avoid, so the personal document is refused by the same rules and the same words.
 *  2. "Personal wins" is layered, not total: a region the person does not mention keeps the PROJECT's
 *     choice, so the three homes compose product → project → person.
 *  3. The source travels WITH the resolution, because a UI that names the wrong home sends someone to
 *     edit the file that was never in effect.
 */
// `kind: "agent"` is load-bearing, not decoration: `isAgentRow` is what the ratified V1 boundary is
// written on, so a fixture without it would silently take the default and prove nothing.
const agent = (over: Partial<AgentVM> = {}): AgentVM => ({ name: "codex", kind: "agent", status: "running", ...over }) as AgentVM;
const terminal = (): AgentVM => ({ name: "dev", kind: "terminal", status: "running" }) as AgentVM;

const project = (written: Record<string, unknown>): CardTemplateConfig => {
  const parsed = parseCardTemplate({ version: CARD_TEMPLATE_VERSION, ...written });
  if (!parsed.config) throw new Error(`project fixture refused: ${parsed.errors.join("; ")}`);
  return parsed.config;
};

/** The personal document, parsed the way the shell parses it: against the project's own template. */
const personal = (written: Record<string, unknown>, base = DEFAULT_CARD_TEMPLATE) =>
  parseCardTemplate({ version: CARD_TEMPLATE_VERSION, ...written }, "tachyon.sidebar.cardTemplate", base);

describe("the personal override is validated by the SAME rules as the project's", () => {
  it("refuses an unknown component with the same words, under its own key path", () => {
    const refused = personal({ meta: ["cpu-graph"] });
    expect(refused.config).toBeUndefined();
    // the key path names the home the person actually edits — the message is otherwise identical
    expect(refused.errors[0]).toContain("tachyon.sidebar.cardTemplate.meta[0]");
    expect(refused.errors[0]).toContain("unknown component 'cpu-graph'");
  });

  it("refuses a missing or unknown version, exactly like the project's template", () => {
    expect(parseCardTemplate({ meta: [] }, "tachyon.sidebar.cardTemplate").errors[0]).toContain("version: required");
    expect(parseCardTemplate({ version: 7, meta: [] }, "tachyon.sidebar.cardTemplate").errors[0]).toContain("unknown template version 7");
  });

  it("refuses whole — a personal override is never half-applied either", () => {
    const refused = personal({ header: ["name"], meta: ["cpu-graph"] });
    expect(refused.config).toBeUndefined();
    expect(refused.errors).toHaveLength(1);
  });
});

describe("personal wins, but only where it speaks", () => {
  it("keeps the PROJECT's region when the person does not mention it", () => {
    const projectConfig = project({ header: ["status-dot", "name"], meta: ["branch", "harness"] });
    const parsed = personal({ meta: ["harness"] }, projectConfig.base);
    expect(parsed.config).toBeDefined();
    // the person spoke about meta only: the project's curated header survives, rather than snapping
    // back to the product default the way a whole-document replacement would.
    expect(parsed.config!.base.header).toEqual(["status-dot", "name"]);
    expect(parsed.config!.base.meta).toEqual(["harness"]);
  });

  it("honors an explicitly empty region from the person, same asymmetry as phase 2", () => {
    const projectConfig = project({ meta: ["branch", "harness"] });
    const parsed = personal({ meta: [] }, projectConfig.base);
    expect(parsed.config!.base.meta).toEqual([]);
  });

  it("a person who writes every region has said 'replace' — without needing a switch for it", () => {
    const projectConfig = project({ header: ["status-dot"], meta: ["branch"], footer: ["actions"] });
    const parsed = personal(
      { header: ["name"], meta: ["harness"], footer: ["focus", "actions"] },
      projectConfig.base,
    );
    expect(parsed.config!.base).toMatchObject({ header: ["name"], meta: ["harness"], footer: ["focus", "actions"] });
  });

  it("leaves the project's own parse untouched — the base defaults to the product's card", () => {
    // The phase-2/3 callers pass no base at all; their behavior must not have moved.
    const parsed = parseCardTemplate({ version: CARD_TEMPLATE_VERSION, meta: ["branch"] });
    expect(parsed.config!.base.header).toEqual(DEFAULT_CARD_TEMPLATE.header);
    expect(parsed.config!.base.footer).toEqual(DEFAULT_CARD_TEMPLATE.footer);
  });
});

describe("merging the two homes records which one is in effect", () => {
  it("marks a project-only configuration as the project's", () => {
    const merged = mergeCardTemplateConfigs(project({ meta: ["branch"] }), undefined)!;
    expect(merged.sources?.base).toBe("project");
    expect(resolveCardTemplateFor(agent(), merged).source).toBe("project");
  });

  it("marks the personal one as personal, and it is the template the row renders", () => {
    const projectConfig = project({ meta: ["branch", "harness"] });
    const personalConfig = personal({ meta: ["harness"] }, projectConfig.base).config!;
    const merged = mergeCardTemplateConfigs(projectConfig, personalConfig)!;
    const resolved = resolveCardTemplateFor(agent(), merged);
    expect(resolved.source).toBe("personal");
    expect(resolved.template.meta).toEqual(["harness"]);
  });

  it("keeps a project's runtime override the person never mentioned, and attributes each correctly", () => {
    const projectConfig = project({
      meta: ["branch"],
      runtimes: { codex: { extends: "default", meta: ["harness"] } },
    });
    const personalConfig = personal(
      { runtimes: { claude: { extends: "default", meta: ["verify"] } } },
      projectConfig.base,
    ).config!;
    const merged = mergeCardTemplateConfigs(projectConfig, personalConfig)!;

    // dropping the project's `codex` override would be the product inventing an opinion the person
    // never expressed — they said nothing about codex at all.
    expect(resolveCardTemplateFor(agent({ runtime: "codex" }), merged)).toMatchObject({ source: "project" });
    expect(resolveCardTemplateFor(agent({ runtime: "claude" }), merged)).toMatchObject({ source: "personal" });
    expect(resolveCardTemplate(agent({ runtime: "codex" }), merged).meta).toEqual(["harness"]);
    expect(resolveCardTemplate(agent({ runtime: "claude" }), merged).meta).toEqual(["verify"]);
  });

  it("a personal runtime override replaces the project's for that runtime only", () => {
    const projectConfig = project({ runtimes: { claude: { extends: "default", meta: ["branch"] } } });
    const personalConfig = personal(
      { runtimes: { claude: { extends: "default", meta: ["harness"] } } },
      projectConfig.base,
    ).config!;
    const merged = mergeCardTemplateConfigs(projectConfig, personalConfig)!;
    expect(resolveCardTemplate(agent({ runtime: "claude" }), merged).meta).toEqual(["harness"]);
    expect(resolveCardTemplateFor(agent({ runtime: "claude" }), merged).source).toBe("personal");
  });

  it("nothing configured anywhere stays undefined — no empty config to carry", () => {
    expect(mergeCardTemplateConfigs(undefined, undefined)).toBeUndefined();
  });

  it("a personal override with no project template still wins, and says so", () => {
    const personalConfig = personal({ meta: ["harness"] }).config!;
    const merged = mergeCardTemplateConfigs(undefined, personalConfig)!;
    expect(merged.sources?.base).toBe("personal");
    expect(merged.base.meta).toEqual(["harness"]);
  });
});

describe("the V1 boundary and the default hold under the personal layer too", () => {
  it("a terminal row takes the product default whatever either home wrote", () => {
    const merged = mergeCardTemplateConfigs(project({ meta: ["branch"] }), personal({ meta: [] }).config)!;
    const resolved = resolveCardTemplateFor(terminal(), merged);
    expect(resolved.template).toBe(DEFAULT_CARD_TEMPLATE);
    // and it is attributed to the default, not to the personal override that never applied to it
    expect(resolved.source).toBe("default");
  });

  it("no configuration at all resolves to the default, attributed as such", () => {
    expect(resolveCardTemplateFor(agent(), undefined)).toEqual({ template: DEFAULT_CARD_TEMPLATE, source: "default" });
  });

  it("resolveCardTemplate stays the same function it was — one lookup, two answers", () => {
    // The pair exists so a UI's claim about the source cannot drift from the template it describes;
    // that only holds while both come from the SAME call.
    const merged = mergeCardTemplateConfigs(project({ meta: ["branch"] }), undefined)!;
    expect(resolveCardTemplate(agent(), merged)).toBe(resolveCardTemplateFor(agent(), merged).template);
  });
});

describe("what the UI says", () => {
  it("names each home in words a person can act on", () => {
    expect(describeCardTemplateSource("personal")).toContain("VS Code settings");
    expect(describeCardTemplateSource("personal")).toContain("wins");
    expect(describeCardTemplateSource("project")).toContain("tachyon.yml");
    expect(describeCardTemplateSource("default")).toContain("default");
  });
});
