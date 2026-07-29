import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_SCHEMA_VERSION,
  GlobalSettingsStore,
  globalSettingsPath,
  parseGlobalSettings,
  resolveGlobalSettings,
  toGlobalSettingsDocument,
  writeGlobalSettingsFile,
} from "../../src/config/globalSettings.js";

function tempHome(): string {
  return makeTempDir("tachyon-global-settings-");
}

function writeRaw(home: string, body: string): string {
  const file = globalSettingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("global settings document", () => {
  it("accepts a full document and resolves every field", () => {
    const parsed = parseGlobalSettings({
      version: 1,
      activity: { codeTheme: "dark" },
      agentPane: { enabled: false },
      gitPath: "/opt/git",
    }, "settings.json");
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings).toMatchObject({
      activityCodeTheme: "dark",
      agentPaneEnabled: false,
      gitPath: "/opt/git",
    });
  });

  it("an empty document is the defaults, not a refusal", () => {
    const parsed = parseGlobalSettings({ version: GLOBAL_SETTINGS_SCHEMA_VERSION }, "settings.json");
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  it("refuses an unknown schema version rather than reinterpreting it", () => {
    const parsed = parseGlobalSettings({ version: 2, gitPath: "/x" }, "settings.json");
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors[0]).toMatch(/'version' must be 1/);
  });

  it("refuses the WHOLE document when one value is invalid — nothing is half-applied", () => {
    const parsed = parseGlobalSettings({
      version: 1,
      activity: { codeTheme: "neon" },
      gitPath: "/opt/git",
    }, "settings.json");
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors.join("\n")).toMatch(/activity\.codeTheme: must be "auto", "dark", or "light"/);
  });

  it("names unknown keys instead of ignoring them", () => {
    const parsed = parseGlobalSettings({ version: 1, maxAgents: 4 }, "settings.json");
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors.join("\n")).toMatch(/unknown key 'maxAgents'/);
  });

  it("keeps the card template in its AUTHORED form so silent regions still inherit the project's", () => {
    const written = { version: 1, header: ["name"] };
    const parsed = parseGlobalSettings({ version: 1, sidebar: { cardTemplate: written } }, "settings.json");
    expect(parsed.errors).toEqual([]);
    // Not the resolved template: `meta`/`footer` must stay unmentioned, or the project's choice for
    // them would be silently overwritten by the default.
    expect(parsed.settings?.sidebarCardTemplate).toEqual(written);
  });

  it("treats a cleared card template as 'nothing configured', not as a refusal", () => {
    for (const cleared of [null, {}]) {
      const parsed = parseGlobalSettings({ version: 1, sidebar: { cardTemplate: cleared } }, "settings.json");
      expect(parsed.errors).toEqual([]);
      expect(parsed.settings?.sidebarCardTemplate).toBeUndefined();
    }
  });

  it("refuses an invalid card template with the same validator tachyon.yml uses", () => {
    const parsed = parseGlobalSettings({ version: 1, sidebar: { cardTemplate: { version: 99 } } }, "settings.json");
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors.join("\n")).toMatch(/unknown template version/);
  });

  it("round-trips through the authored document shape", () => {
    const document = toGlobalSettingsDocument({
      activityCodeTheme: "light",
      agentPaneEnabled: false,
      sidebarCardTemplate: { version: 1, header: ["name"] },
      gitPath: "/usr/local/bin/git",
    });
    const parsed = parseGlobalSettings(document, "settings.json");
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings).toEqual({
      activityCodeTheme: "light",
      agentPaneEnabled: false,
      sidebarCardTemplate: { version: 1, header: ["name"] },
      gitPath: "/usr/local/bin/git",
    });
  });
});

describe("agentPane.enabled fails toward enabled", () => {
  it("a refused document cannot leave the pane disabled, even from a last-known-good that disabled it", () => {
    const lkg = { ...DEFAULT_GLOBAL_SETTINGS, agentPaneEnabled: false, gitPath: "/opt/git" };
    const state = resolveGlobalSettings(lkg, { file: "settings.json", errors: ["boom"] });
    expect(state.settings.agentPaneEnabled).toBe(true);
    // everything else still inherits the last good document
    expect(state.settings.gitPath).toBe("/opt/git");
    expect(state.refusal?.errors).toEqual(["boom"]);
  });

  it("an absent value is enabled", () => {
    const parsed = parseGlobalSettings({ version: 1 }, "settings.json");
    expect(parsed.settings?.agentPaneEnabled).toBe(true);
  });
});

describe("global settings store", () => {
  it("an absent file is the defaults with no refusal", () => {
    const store = new GlobalSettingsStore(tempHome());
    expect(store.current()).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(store.refusal()).toBeUndefined();
  });

  it("keeps the last known good when the file later becomes invalid, and names the refusal", () => {
    const home = tempHome();
    writeRaw(home, JSON.stringify({ version: 1, gitPath: "/opt/git", activity: { codeTheme: "dark" } }));
    const store = new GlobalSettingsStore(home);
    expect(store.current().gitPath).toBe("/opt/git");

    writeRaw(home, "{ not json");
    const state = store.reload();
    expect(state.settings.gitPath).toBe("/opt/git");
    expect(state.settings.activityCodeTheme).toBe("dark");
    expect(state.refusal?.errors.join("\n")).toMatch(/not valid JSON/);
  });

  it("recovers when the hand edit is fixed", () => {
    const home = tempHome();
    writeRaw(home, "{ not json");
    const store = new GlobalSettingsStore(home);
    expect(store.refusal()).toBeDefined();
    expect(store.current()).toEqual(DEFAULT_GLOBAL_SETTINGS);

    writeRaw(home, JSON.stringify({ version: 1, gitPath: "/fixed/git" }));
    expect(store.reload().refusal).toBeUndefined();
    expect(store.current().gitPath).toBe("/fixed/git");
  });

  it("update() persists through temp+rename and leaves no stray temp file", () => {
    const home = tempHome();
    const store = new GlobalSettingsStore(home);
    store.update({ gitPath: "/opt/git", activityCodeTheme: "light" });

    const dir = path.dirname(globalSettingsPath(home));
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    expect(new GlobalSettingsStore(home).current()).toMatchObject({
      gitPath: "/opt/git",
      activityCodeTheme: "light",
    });
  });

  it("update() refuses to write a document the loader would refuse", () => {
    const store = new GlobalSettingsStore(tempHome());
    expect(() => store.update({ activityCodeTheme: "neon" as never })).toThrow(/refusing to write invalid/);
  });

  it("writeGlobalSettingsFile produces a document the parser accepts", () => {
    const home = tempHome();
    const file = globalSettingsPath(home);
    writeGlobalSettingsFile(file, toGlobalSettingsDocument({ ...DEFAULT_GLOBAL_SETTINGS, gitPath: "/g" }));
    const parsed = parseGlobalSettings(JSON.parse(fs.readFileSync(file, "utf8")), file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings?.gitPath).toBe("/g");
  });
});
