import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __resetVscodeMock, __setConfiguration, __fireConfigurationChange, __getExecutedCommands } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import { SAMPLE, type FleetVM } from "../../src/sidebar/types.js";
import { CARD_TEMPLATE_VERSION, DEFAULT_CARD_TEMPLATE, parseCardTemplate, resolveCardTemplate } from "../../src/sidebar/cardTemplate.js";
import type { WorkspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";

/**
 * SDD 479 phase 5 — the personal override, from VS Code settings to the pushed fleet.
 *
 * The model-level tests prove the layering; these prove the SHELL does what only it can be wrong
 * about: reading the person's setting, resolving it against THIS folder's project template, failing
 * closed with a diagnostic when it cannot, and repainting when the setting changes.
 *
 * The personal layer is deliberately absent from the engine's projection — it belongs to one person
 * on one machine, and an agent-authored checkout must never be able to carry it. That is why this is
 * tested through the provider rather than through `sidebarFleetService`.
 */
const KEY = "tachyon.sidebar.cardTemplate";

const projectTemplate = (written: Record<string, unknown>) => {
  const parsed = parseCardTemplate({ version: CARD_TEMPLATE_VERSION, ...written });
  if (!parsed.config) throw new Error(parsed.errors.join("; "));
  return parsed.config;
};

function fakeView(): { view: vscode.WebviewView; posted: unknown[] } {
  const posted: unknown[] = [];
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async (msg: unknown) => { posted.push(msg); return true; },
    onDidReceiveMessage: () => ({ dispose() {} }),
    html: "",
  };
  return { view: { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewView, posted };
}

function provider(fleet: Partial<FleetVM>): { provider: SidebarPrototypeProvider } {
  const target = {
    wsHash: "demohash",
    folderName: "Demo",
    workspaceRoot: "/workspace/Demo",
    loadSidebar: async () => ({ ...SAMPLE, folder: { hash: "demohash", name: "Demo" }, ...fleet }),
  } as unknown as WorkspaceSidebarTarget;
  return { provider: new SidebarPrototypeProvider(vscode.Uri.file("/ext"), () => [target]) };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The last fleet the provider pushed to the webview. */
const pushedFleet = (posted: unknown[]): FleetVM | undefined => {
  const message = [...posted].reverse().find((m) => (m as { type?: string }).type === "fleet") as
    | { fleets?: FleetVM[] }
    | undefined;
  return message?.fleets?.[0];
};

beforeEach(() => __resetVscodeMock());
afterEach(() => __resetVscodeMock());

describe("no personal override", () => {
  it("pushes the project's template, attributed to the project", async () => {
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    expect(fleet?.cardTemplate?.base.meta).toEqual(["branch"]);
    expect(fleet?.cardTemplate?.sources?.base).toBe("project");
    expect(fleet?.personalCardTemplateRefusal).toBeUndefined();
  });

  it("treats an EMPTY settings object as 'not configured', never as a refusal", async () => {
    // The settings UI writes `{}` for an object key a person merely opened; calling that a refusal
    // would put a warning banner on the sidebar of everyone who looked at the setting.
    __setConfiguration({ [KEY]: {} });
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    expect(pushedFleet(posted)?.personalCardTemplateRefusal).toBeUndefined();
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("project");
  });
});

describe("a valid personal override", () => {
  it("wins over the project, and keeps the project's regions it did not mention", async () => {
    __setConfiguration({ [KEY]: { version: CARD_TEMPLATE_VERSION, meta: ["harness"] } });
    const { provider: p } = provider({
      cardTemplate: projectTemplate({ header: ["status-dot", "name"], meta: ["branch", "harness"] }),
    });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    expect(fleet?.cardTemplate?.base.meta).toEqual(["harness"]);
    // the project's curated header survives — "personal wins" is layered, not a whole-document swap
    expect(fleet?.cardTemplate?.base.header).toEqual(["status-dot", "name"]);
    expect(fleet?.cardTemplate?.sources?.base).toBe("personal");
  });

  it("applies to a folder with no project template at all", async () => {
    __setConfiguration({ [KEY]: { version: CARD_TEMPLATE_VERSION, meta: [] } });
    const { provider: p } = provider({});
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    expect(pushedFleet(posted)?.cardTemplate?.base.meta).toEqual([]);
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("personal");
  });
});

describe("an invalid personal override fails closed, and says so", () => {
  it("falls back to the PROJECT's template and reports the refusal against the settings key", async () => {
    __setConfiguration({ [KEY]: { version: CARD_TEMPLATE_VERSION, meta: ["cpu-graph"] } });
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    // the fallback is the project's card, NOT the product default: the person's override failed, the
    // project's did not, and dropping both would punish the wrong author.
    expect(fleet?.cardTemplate?.base.meta).toEqual(["branch"]);
    expect(fleet?.cardTemplate?.sources?.base).toBe("project");
    expect(fleet?.personalCardTemplateRefusal?.file).toContain("tachyon.sidebar.cardTemplate");
    expect(fleet?.personalCardTemplateRefusal?.errors[0]).toContain("unknown component 'cpu-graph'");
    // …and the project's own refusal channel stays untouched: two homes, two diagnostics
    expect(fleet?.cardTemplateRefusal).toBeUndefined();
  });

  it("falls back to the product default when neither home has a valid template", async () => {
    __setConfiguration({ [KEY]: { version: 9 } });
    const { provider: p } = provider({});
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    expect(fleet?.cardTemplate).toBeUndefined(); // nothing configured survives → the default card
    expect(fleet?.personalCardTemplateRefusal?.errors[0]).toContain("unknown template version 9");
  });

  it("keeps BOTH refusals when the project's template is also broken", async () => {
    __setConfiguration({ [KEY]: { version: CARD_TEMPLATE_VERSION, footer: ["branch"] } });
    const { provider: p } = provider({
      cardTemplateRefusal: { file: "tachyon.yml", errors: ["settings.sidebar.cardTemplate.meta[0]: unknown component 'x'"] },
    });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    // A person fixing this needs to know WHICH file to open; one merged banner could not say.
    expect(fleet?.cardTemplateRefusal?.file).toBe("tachyon.yml");
    expect(fleet?.personalCardTemplateRefusal?.file).toContain("VS Code settings");
    // Neither home survived, so no template travels at all — and the renderer's own "nothing
    // configured" path is the product default. Sending an explicit copy of the default instead would
    // make "the project wrote a template that happens to match the default" indistinguishable from
    // "both templates were refused", which is exactly the distinction the two banners exist to draw.
    expect(fleet?.cardTemplate).toBeUndefined();
    expect(resolveCardTemplate({ kind: "agent" } as never, fleet?.cardTemplate)).toEqual(DEFAULT_CARD_TEMPLATE);
  });
});

describe("editing the setting repaints the cards", () => {
  it("re-pushes when the personal key changes, with the new template", async () => {
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("project");

    __setConfiguration({ [KEY]: { version: CARD_TEMPLATE_VERSION, meta: ["harness"] } });
    __fireConfigurationChange(KEY);
    await flush();

    // without this, a person edits a template and watches nothing happen until an unrelated refresh
    expect(pushedFleet(posted)?.cardTemplate?.base.meta).toEqual(["harness"]);
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("personal");
  });

  it("ignores a change to an unrelated setting", async () => {
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();
    const before = posted.length;

    __fireConfigurationChange("tachyon.maxAgents");
    await flush();

    expect(posted.length).toBe(before);
  });
});

describe("the refusal banner's button", () => {
  it("opens the settings editor filtered to the key it names", async () => {
    const { provider: p } = provider({});
    const { view } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    // the sidebar posts this when the personal banner's "Open …" is clicked
    await (p as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage({
      type: "global",
      op: "openPersonalCardTemplate",
    });

    expect(__getExecutedCommands()).toContainEqual({
      command: "workbench.action.openSettings",
      args: [KEY],
    });
  });
});
