import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildSectionsModel, type WorkspaceBundle } from "@tachyon/webview-ui/sections/model";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { CockpitStrings } from "../../packages/webview-ui/src/webview/shared/control/messages.js";

/** The block is a .tsx: compiled through the shared static-preact loader, like phase 4's own test. */
let CardTemplateInEffect: (props: unknown) => unknown;
beforeAll(async () => {
  const mod = await loadWebviewModule(path.join(__dirname, "../../packages/webview-ui/src/webview/shared/control/CardTemplateBlock.tsx"));
  CardTemplateInEffect = mod.CardTemplateInEffect as typeof CardTemplateInEffect;
}, 60_000);

/**
 * SDD 479 phase 5 — "the settings UI says which one is in effect" (ratified fork 1).
 *
 * That sentence is part of the feature, not a nicety, and the reason is a specific failure: a
 * personal override quietly contradicting the project's template is indistinguishable from a broken
 * project template. So what is asserted here is that the statement reflects LIVE state from both
 * homes — a block that merely restated the precedence rule would be true and useless.
 */
const STRINGS = {
  cardTemplateInEffect: "In effect right now:",
  cardTemplatePersonalActive: "your personal override in VS Code settings — it wins over every project template below",
  cardTemplatePersonalRefused: "your personal override was REFUSED and ignored; the cards fall back to each project's template",
  cardTemplatePersonalNone: "no personal override — each project's own template decides",
  cardTemplateProjectNone: "uses Tachyon's default card",
  cardTemplateProjectConfigured: "has its own template in tachyon.yml",
  cardTemplateProjectRefused: "its tachyon.yml template was refused; showing the default card",
} as unknown as CockpitStrings;

const bundle = (folder: string, cardTemplate?: { configured: boolean; refused: boolean }): WorkspaceBundle => ({
  control: { folderName: folder, workspaceRoot: `/w/${folder}`, wsHash: folder, bridgeUrl: "" },
  agents: [],
  worktrees: [],
  approvals: [],
  ...(cardTemplate ? { cardTemplate } : {}),
});

describe("the model reports both homes", () => {
  it("defaults to 'no personal override' when the host reported none", () => {
    const model = buildSectionsModel([bundle("alpha")], { nowIso: "now" });
    expect(model.cardTemplate).toMatchObject({ personal: "none", projects: [{ folder: "alpha", configured: false, refused: false }] });
  });

  it("carries the personal state and its refusal reasons verbatim", () => {
    const model = buildSectionsModel([bundle("alpha")], {
      nowIso: "now",
      personalCardTemplate: { state: "refused", errors: ["sidebar.cardTemplate.meta[0]: unknown component 'cpu-graph'"] },
    });
    expect(model.cardTemplate?.personal).toBe("refused");
    // the same words the sidebar banner shows, from the same validator — a person should not have to
    // cross-reference two surfaces to learn why their override was ignored
    expect(model.cardTemplate?.personalErrors?.[0]).toContain("unknown component 'cpu-graph'");
  });

  it("reports each workspace on its own terms — two folders can legitimately disagree", () => {
    // t-72ff5a — this used to be read off the unscoped aggregate, which no longer exists: with no
    // selection the model resolves to the first attached project (the sidebar renders exactly one,
    // so an "every project" scope would be a state it cannot display). The property the test is
    // about is untouched and is what is asserted now — a project's card layout comes from ITS OWN
    // tachyon.yml, so the answer changes with the project rather than being folded across them.
    const bundles = [bundle("alpha", { configured: true, refused: false }), bundle("beta", { configured: false, refused: true })];
    expect(buildSectionsModel(bundles, { nowIso: "now" }).cardTemplate?.projects)
      .toEqual([{ folder: "alpha", configured: true, refused: false }]);
    expect(buildSectionsModel(bundles, { nowIso: "now", wsHash: "beta" }).cardTemplate?.projects)
      .toEqual([{ folder: "beta", configured: false, refused: true }]);
  });

  it("narrows to the selected workspace, like every other scoped section", () => {
    const model = buildSectionsModel(
      [bundle("alpha", { configured: true, refused: false }), bundle("beta")],
      { nowIso: "now", wsHash: "beta" },
    );
    expect(model.cardTemplate?.projects).toEqual([{ folder: "beta", configured: false, refused: false }]);
  });
});

describe("what the block renders", () => {
  it("names the personal override as the winner when it is active", () => {
    const html = renderStatic(
      CardTemplateInEffect({ s: STRINGS, state: { personal: "active", projects: [{ folder: "alpha", configured: true, refused: false }] } }),
    );
    expect(html).toContain("wins over every project template");
    // the project's own state is still listed: the human sees WHAT is being overridden, not just that
    // something is
    expect(html).toContain("alpha");
    expect(html).toContain("has its own template in tachyon.yml");
  });

  it("says the personal override was refused, and shows why", () => {
    const html = renderStatic(
      CardTemplateInEffect({
        s: STRINGS,
        state: {
          personal: "refused",
          personalErrors: ["sidebar.cardTemplate.meta[0]: unknown component 'cpu-graph'"],
          projects: [{ folder: "alpha", configured: true, refused: false }],
        },
      }),
    );
    expect(html).toContain("REFUSED");
    expect(html).toContain("unknown component 'cpu-graph'");
    expect(html).toContain("card-template-effect-errors");
  });

  it("says plainly when nothing personal is set", () => {
    const html = renderStatic(
      CardTemplateInEffect({ s: STRINGS, state: { personal: "none", projects: [{ folder: "alpha", configured: false, refused: false }] } }),
    );
    expect(html).toContain("no personal override");
    expect(html).toContain("uses Tachyon's default card");
    expect(html).not.toContain("card-template-effect-errors");
  });

  it("distinguishes a refused project template from an absent one", () => {
    // Without this distinction the two read identically — a default card — and the person cannot tell
    // "nobody configured this" from "somebody configured it wrong".
    const html = renderStatic(
      CardTemplateInEffect({ s: STRINGS, state: { personal: "none", projects: [{ folder: "beta", configured: false, refused: true }] } }),
    );
    expect(html).toContain("was refused");
    expect(html).not.toContain("uses Tachyon's default card");
  });
});
