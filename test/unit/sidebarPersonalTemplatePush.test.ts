import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { __resetVscodeMock, __fireFileWatch, __getExecutedCommands } from "../mocks/vscode.js";
import { globalSettingsPath, useGlobalSettingsHome } from "../../src/config/globalSettings.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import { SAMPLE, type FleetVM } from "@tachyon/shared/sidebar/types.js";
import { CARD_TEMPLATE_VERSION, DEFAULT_CARD_TEMPLATE, parseCardTemplate, resolveCardTemplate } from "@tachyon/shared/sidebar/cardTemplate.js";
import type { WorkspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";

/**
 * SDD 479 phase 5 — the personal override, from its own home to the pushed fleet.
 *
 * t-aaad95 — that home moved from a VS Code settings key to `sidebar.cardTemplate` in the global
 * Tachyon settings file. Everything this file proves is unchanged in substance; what changed is where
 * the shell reads it from, and that a repaint is now driven by a FILE event rather than a
 * configuration event.
 *
 * The model-level tests prove the layering; these prove the SHELL does what only it can be wrong
 * about: reading the person's setting, resolving it against THIS folder's project template, failing
 * closed with a diagnostic when it cannot, and repainting when the setting changes.
 *
 * The personal layer is deliberately absent from the engine's projection — it belongs to one person
 * on one machine, and an agent-authored checkout must never be able to carry it. That is why this is
 * tested through the provider rather than through `sidebarFleetService`.
 */
/**
 * Point the process-wide store at a throwaway home and author the personal document there. Writing
 * the real file (rather than stubbing the store) is deliberate: the parse, the fail-closed refusal
 * and the last-known-good all live in the store, and a stub would skip exactly the code a person
 * hand-editing this file depends on.
 */
let home: string;
function setPersonalTemplate(written: unknown): void {
  const file = globalSettingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, sidebar: { cardTemplate: written } }, null, 2), "utf8");
  useGlobalSettingsHome(home);
}

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

beforeEach(() => {
  __resetVscodeMock();
  home = makeTempDir("tachyon-personal-template-");
  useGlobalSettingsHome(home);
});
afterEach(() => {
  __resetVscodeMock();
  useGlobalSettingsHome(undefined);
});

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
    setPersonalTemplate({});
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
    setPersonalTemplate({ version: CARD_TEMPLATE_VERSION, meta: ["harness"] });
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
    setPersonalTemplate({ version: CARD_TEMPLATE_VERSION, meta: [] });
    const { provider: p } = provider({});
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    expect(pushedFleet(posted)?.cardTemplate?.base.meta).toEqual([]);
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("personal");
  });
});

describe("an invalid personal override fails closed, and says so", () => {
  it("falls back to the PROJECT's template and names the file the person has to fix", async () => {
    setPersonalTemplate({ version: CARD_TEMPLATE_VERSION, meta: ["cpu-graph"] });
    const { provider: p } = provider({ cardTemplate: projectTemplate({ meta: ["branch"] }) });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    // the fallback is the project's card, NOT the product default: the person's override failed, the
    // project's did not, and dropping both would punish the wrong author.
    expect(fleet?.cardTemplate?.base.meta).toEqual(["branch"]);
    expect(fleet?.cardTemplate?.sources?.base).toBe("project");
    expect(fleet?.personalCardTemplateRefusal?.file).toContain(globalSettingsPath(home));
    expect(fleet?.personalCardTemplateRefusal?.errors[0]).toContain("unknown component 'cpu-graph'");
    // …and the project's own refusal channel stays untouched: two homes, two diagnostics
    expect(fleet?.cardTemplateRefusal).toBeUndefined();
  });

  it("falls back to the product default when neither home has a valid template", async () => {
    setPersonalTemplate({ version: 9 });
    const { provider: p } = provider({});
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    expect(fleet?.cardTemplate).toBeUndefined(); // nothing configured survives → the default card
    expect(fleet?.personalCardTemplateRefusal?.errors[0]).toContain("unknown template version 9");
  });

  it("keeps BOTH refusals when the project's template is also broken", async () => {
    setPersonalTemplate({ version: CARD_TEMPLATE_VERSION, footer: ["branch"] });
    const { provider: p } = provider({
      cardTemplateRefusal: { file: "tachyon.yml", errors: ["settings.sidebar.cardTemplate.meta[0]: unknown component 'x'"] },
    });
    const { view, posted } = fakeView();
    p.resolveWebviewView(view);
    await flush();

    const fleet = pushedFleet(posted);
    // A person fixing this needs to know WHICH file to open; one merged banner could not say.
    expect(fleet?.cardTemplateRefusal?.file).toBe("tachyon.yml");
    expect(fleet?.personalCardTemplateRefusal?.file).toContain(globalSettingsPath(home));
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

    setPersonalTemplate({ version: CARD_TEMPLATE_VERSION, meta: ["harness"] });
    __fireFileWatch();
    await flush();

    // without this, a person edits a template and watches nothing happen until an unrelated refresh
    expect(pushedFleet(posted)?.cardTemplate?.base.meta).toEqual(["harness"]);
    expect(pushedFleet(posted)?.cardTemplate?.sources?.base).toBe("personal");
  });

  // t-aaad95 — the "ignores an unrelated setting" case is gone by construction rather than by
  // assertion: the watcher is scoped to ONE file, so an unrelated setting cannot reach it at all.
  // The watcher's scope is now the guarantee that the `affectsConfiguration` check used to be.
});

describe("the refusal banner's button", () => {
  it("opens the Tachyon settings file — which is also the recovery path when Control will not open", async () => {
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
      command: "tachyon.openGlobalSettings",
      args: [],
    });
  });
});
