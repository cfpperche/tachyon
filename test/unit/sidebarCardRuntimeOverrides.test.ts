import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { parseConfig } from "../../src/config/loadConfig.js";
import { toAgentVM } from "../../src/sidebar/agentModel.js";
import { SUPPORTED_AGENT_RUNTIME_NAMES } from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import {
  CARD_TEMPLATE_VERSION,
  DEFAULT_CARD_TEMPLATE,
  parseCardTemplate,
  resolveCardTemplate,
} from "@tachyon/shared/sidebar/cardTemplate.js";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * SDD 479 phase 3 — per-runtime overrides, ratified fork 2: an override DECLARES its inheritance and
 * the product never guesses.
 *
 * The ratified text ("`extends: default` or `replace`") left two things unsaid, and both are decided
 * here rather than in whoever reads the code next:
 *
 *  - what `default` layers ONTO — the project's template, so product → project → runtime compose, and
 *    one runtime's override never silently discards what the project chose for every other row;
 *  - what a PARTIAL `replace` means — nothing, so it is refused: "exactly as written" written in half
 *    would mean a card with no name and no actions for anyone who only wanted different badges.
 */
const BASE = `terminals:\n  dev:\n    cmd: bash\n`;
const load = (settings: string) => parseConfig(`${BASE}${settings}`);

const templateFor = (yaml: string) => load(yaml).config?.settings.sidebar?.cardTemplate;
const refusalFor = (yaml: string) => (load(yaml).config?.settings.sidebar?.cardTemplateRefusal ?? []).join("\n");

describe("SDD 479 phase 3 — a runtime override declares its own inheritance", () => {
  it("layers `extends: default` onto the PROJECT template, region by region", () => {
    const config = templateFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, evidence]
      footer: [actions]
      runtimes:
        claude:
          extends: default
          meta: [branch, continuity]
`);
    // the override changed meta…
    expect(config?.runtimes?.claude.meta).toEqual(["branch", "continuity"]);
    // …and inherited the PROJECT's footer, not the product default's
    expect(config?.runtimes?.claude.footer).toEqual(["actions"]);
    expect(config?.base.footer).toEqual(["actions"]);
    // …and the project's own header, which was itself the product default
    expect(config?.runtimes?.claude.header).toEqual(DEFAULT_CARD_TEMPLATE.header);
  });

  it("takes `extends: replace` exactly as written, inheriting nothing", () => {
    const config = templateFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch, evidence]
      runtimes:
        codex:
          extends: replace
          header: [status-dot, name]
          meta: []
          footer: [actions]
`);
    expect(config?.runtimes?.codex).toEqual({
      version: CARD_TEMPLATE_VERSION,
      header: ["status-dot", "name"],
      meta: [],
      footer: ["actions"],
    });
    // the project's meta did NOT leak in
    expect(config?.base.meta).toEqual(["branch", "evidence"]);
  });

  it("refuses a PARTIAL replace, naming the regions it would silently blank", () => {
    const refusal = refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        claude:
          extends: replace
          meta: [branch]
`);
    expect(refusal).toContain("inherits nothing, so it must list every region");
    expect(refusal).toContain("header");
    expect(refusal).toContain("footer");
    expect(refusal).toContain("Use 'extends: default'");
  });

  it("refuses an override with no `extends` at all — the answer is never implicit", () => {
    const refusal = refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        claude:
          meta: [branch]
`);
    expect(refusal).toContain("extends: required");
    expect(refusal).toContain("'default'");
    expect(refusal).toContain("'replace'");
  });

  it("refuses an unknown inheritance word instead of picking the friendlier reading", () => {
    expect(refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        claude:
          extends: merge
          meta: [branch]
`)).toContain(`must be 'default' or 'replace', not "merge"`);
  });

  it("refuses a runtime Tachyon does not run agents on, and lists the ones it does", () => {
    const refusal = refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        emacs:
          extends: default
          meta: [branch]
`);
    expect(refusal).toContain("unknown runtime 'emacs'");
    for (const runtime of SUPPORTED_AGENT_RUNTIME_NAMES) expect(refusal).toContain(runtime);
  });

  it("accepts every runtime the product can run an agent on — including the non-attested ones", () => {
    // Validated against SUPPORTED_AGENT_RUNTIME_NAMES, not the narrower attested four: a Temporary
    // agent may be OpenCode/Gemini/Qwen/Hermes, and refusing those keys would refuse an override for
    // rows this product creates.
    for (const runtime of SUPPORTED_AGENT_RUNTIME_NAMES) {
      const config = templateFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        ${runtime}:
          extends: default
          meta: [branch]
`);
      expect(config?.runtimes?.[runtime]?.meta, `${runtime} must be overridable`).toEqual(["branch"]);
    }
  });

  it("validates an override's components with the same rules as the project template", () => {
    const refusal = refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        claude:
          extends: default
          meta: [branch, cpu-graph, branch]
          header: [model-provenance]
`);
    expect(refusal).toContain("unknown component 'cpu-graph'");
    expect(refusal).toContain("duplicate component 'branch'");
    expect(refusal).toContain("renders inside 'model'");
    expect(refusal).toContain("settings.sidebar.cardTemplate.runtimes.claude.meta[1]");
  });

  it("refuses an unknown key inside an override", () => {
    expect(refusalFor(`settings:
  sidebar:
    cardTemplate:
      version: 1
      runtimes:
        claude:
          extends: default
          badges: [branch]
`)).toContain("unknown key 'badges'");
  });

  it("refuses the whole document when one override is wrong — never some runtimes and not others", () => {
    const result = load(`settings:
  sidebar:
    cardTemplate:
      version: 1
      meta: [branch]
      runtimes:
        claude:
          extends: default
          meta: [evidence]
        codex:
          extends: merge
          meta: [harness]
`);
    // the good override does not survive the bad one
    expect(result.config?.settings.sidebar?.cardTemplate).toBeUndefined();
    expect(result.config?.settings.sidebar?.cardTemplateRefusal?.length).toBeGreaterThan(0);
    // …and the file itself still loads
    expect(result.errors).toEqual([]);
    expect(result.config?.agents.dev).toBeDefined();
  });
});

describe("SDD 479 phase 3 — which template a row actually gets", () => {
  const config = parseCardTemplate({
    version: CARD_TEMPLATE_VERSION,
    meta: ["branch"],
    runtimes: { claude: { extends: "default", meta: ["harness"] } },
  }).config!;

  const row = (over: Partial<AgentVM>): AgentVM => ({ name: "a", status: "running", kind: "agent", ...over });

  it("gives a row of the overridden runtime the override", () => {
    expect(resolveCardTemplate(row({ runtime: "claude" }), config).meta).toEqual(["harness"]);
  });

  it("gives every other runtime the project template — the fallback is a lookup miss, not a merge", () => {
    expect(resolveCardTemplate(row({ runtime: "codex" }), config).meta).toEqual(["branch"]);
    expect(resolveCardTemplate(row({ runtime: "opencode" }), config).meta).toEqual(["branch"]);
  });

  it("gives a row with no known runtime the project template", () => {
    expect(resolveCardTemplate(row({}), config).meta).toEqual(["branch"]);
  });

  it("still gives a terminal row the product default, even one whose runtime has an override", () => {
    // The V1 boundary outranks the override: `kind` is checked before the runtime is ever looked up.
    expect(resolveCardTemplate({ kind: "terminal", runtime: "claude" }, config)).toBe(DEFAULT_CARD_TEMPLATE);
  });
});

describe("SDD 479 phase 3 — the row reports the runtime the override keys on", () => {
  it("derives it from the command, by the same function the model label uses", () => {
    expect(toAgentVM({ name: "a", cmd: "claude --model opus", running: true, dead: false, crashed: false }, { kind: "agent" }).runtime).toBe("claude");
    expect(toAgentVM({ name: "b", cmd: "codex", running: true, dead: false, crashed: false }, { kind: "agent" }).runtime).toBe("codex");
  });

  it("leaves it absent for a terminal and for an unrecognized binary", () => {
    expect(toAgentVM({ name: "t", cmd: "claude", running: true, dead: false, crashed: false }, { kind: "terminal" }).runtime).toBeUndefined();
    expect(toAgentVM({ name: "u", cmd: "./my-script.sh", running: true, dead: false, crashed: false }, { kind: "agent" }).runtime).toBeUndefined();
    expect(toAgentVM({ name: "v", running: true, dead: false, crashed: false }, { kind: "agent" }).runtime).toBeUndefined();
  });
});

describe("SDD 479 phase 3 — end to end through the real card", () => {
  let AgentRow: (props: unknown) => unknown;
  beforeAll(async () => {
    AgentRow = (await loadWebviewModule(path.join(__dirname, "../../src/webview/sidebar/App.tsx"))).AgentRow as typeof AgentRow;
  });

  const config = parseCardTemplate({
    version: CARD_TEMPLATE_VERSION,
    meta: ["branch"],
    runtimes: { claude: { extends: "default", meta: ["harness", "branch"] } },
  }).config!;

  const agent = (over: Partial<AgentVM>): AgentVM =>
    ({ name: "row", status: "running", kind: "agent", liveBranch: "main", harness: true, ...over });

  it("renders the override for a Claude row and the project template for a Codex one", () => {
    const claude = renderStatic(AgentRow({ a: agent({ runtime: "claude" }), flash: false, cardTemplate: config }));
    const codex = renderStatic(AgentRow({ a: agent({ runtime: "codex" }), flash: false, cardTemplate: config }));

    expect(claude).toContain("⚙ harness");
    expect(claude).toContain("⎇ main");
    expect(claude.indexOf("⚙ harness")).toBeLessThan(claude.indexOf("⎇ main"));

    // the project template lists branch only — the harness badge is absent, not merely reordered
    expect(codex).toContain("⎇ main");
    expect(codex).not.toContain("⚙ harness");
  });

  it("still re-admits a hidden failure state on an overridden row", () => {
    const hideAll = parseCardTemplate({
      version: CARD_TEMPLATE_VERSION,
      runtimes: { claude: { extends: "replace", header: ["status-dot", "name"], meta: [], footer: ["actions"] } },
    }).config!;
    const html = renderStatic(AgentRow({
      a: agent({ runtime: "claude", authRequired: { runtime: "claude", action: "run `claude login`" } }),
      flash: false,
      cardTemplate: hideAll,
    }));
    expect(html).toContain("◆ auth required");
    expect(html).toContain("Your card template omits this badge");
  });
});
