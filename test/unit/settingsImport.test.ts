/**
 * t-aaad95 — the case this import exists for, stated as a test.
 *
 * Measured precedence before the cut was `tachyon.yml` > the VS Code key > the default. So the person
 * at risk is NOT the one who configured the yml (their value already won) but the one who configured
 * only VS Code: they drop to the default the moment the key stops being read. The first test here is
 * that case, and it is the reason step 1 of the ratified plan was a measurement and not a guess.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  planGlobalImport,
  planYmlImport,
  recordSettingsImport,
  settingsImportAlreadyRan,
  settingsImportMarkerPath,
} from "../../src/config/settingsImport.js";
import { setSettingsValue } from "../../src/config/YamlConfigEditor.js";
import { loadConfigFile } from "../../src/config/loadConfig.js";

const nothingSet = (): boolean => false;

describe("the value that would otherwise be lost", () => {
  it("carries a VS Code-only maxAgents into tachyon.yml, so the effective number does not move", () => {
    const writes = planYmlImport({ maxAgents: 3 }, nothingSet);
    expect(writes).toEqual([{ keyPath: ["maxAgents"], value: 3 }]);
  });

  it("survives a real round trip: VS Code-only value in, same effective value out of loadConfig", () => {
    const root = makeTempDir("tachyon-settings-import-");
    const file = path.join(root, "tachyon.yml");
    fs.writeFileSync(file, "agents:\n  ada:\n    cmd: codex\n", "utf8");

    let text = fs.readFileSync(file, "utf8");
    for (const write of planYmlImport({ maxAgents: 3, worktreesRevealInWorkspace: false }, nothingSet)) {
      text = setSettingsValue(text, write.keyPath, write.value).text;
    }
    fs.writeFileSync(file, text, "utf8");

    const parsed = loadConfigFile(file);
    expect(parsed.errors ?? []).toEqual([]);
    expect(parsed.config?.settings.maxAgents).toBe(3);
    expect(parsed.config?.settings.worktree?.revealInWorkspace).toBe(false);
  });
});

describe("the import never overwrites a decision already made", () => {
  it("skips a yml key the project already declares", () => {
    const declared = (keyPath: string[]) => keyPath.join(".") === "maxAgents";
    expect(planYmlImport({ maxAgents: 3, agentMemoryMax: "2G" }, declared))
      .toEqual([{ keyPath: ["agentMemoryMax"], value: "2G" }]);
  });

  it("skips a global key already authored in the new authority", () => {
    expect(planGlobalImport(
      { gitPath: "/legacy/git", activityCodeTheme: "light" },
      ["gitPath", "activityCodeTheme"],
    )).toEqual({});
  });

  // The bug this pins: comparing VALUES instead of PRESENCE conflates "never mentioned" with
  // "deliberately set to what the default happens to be", and then overwrites the deliberate choice.
  it("respects a new-authority value that was authored AT the default", () => {
    expect(planGlobalImport({ agentPaneEnabled: false }, ["agentPaneEnabled"])).toEqual({});
    expect(planGlobalImport({ activityCodeTheme: "dark" }, ["activityCodeTheme"])).toEqual({});
    expect(planGlobalImport({ gitPath: "/legacy/git" }, ["gitPath"])).toEqual({});
  });

  it("is idempotent: a second pass over its own result writes nothing", () => {
    const legacy = { maxAgents: 3, agentMemoryMax: "2G" };
    const written = new Set(planYmlImport(legacy, nothingSet).map((w) => w.keyPath.join(".")));
    expect(planYmlImport(legacy, (keyPath) => written.has(keyPath.join(".")))).toEqual([]);
  });
});

describe("only values a person actually authored, and only valid ones", () => {
  it("ignores absent, malformed and empty legacy values", () => {
    expect(planYmlImport({
      maxAgents: 0,
      agentMemoryMax: "   ",
      worktreesRevealInWorkspace: "yes",
      taskNotifications: { dedupeWindowMs: -1, events: [1, 2] },
    }, nothingSet)).toEqual([]);
    expect(planGlobalImport({
      activityCodeTheme: "neon",
      agentPaneEnabled: "true",
      gitPath: "   ",
    }, [])).toEqual({});
  });

  it("imports a disabled agent pane — the fail-toward-enabled rule guards refusals, not choices", () => {
    expect(planGlobalImport({ agentPaneEnabled: false }, []))
      .toEqual({ agentPaneEnabled: false });
  });

  it("carries the card template in its authored form", () => {
    const template = { version: 1, header: ["name"] };
    expect(planGlobalImport({ sidebarCardTemplate: template }, []))
      .toEqual({ sidebarCardTemplate: template });
    // a cleared key is not a configuration
    expect(planGlobalImport({ sidebarCardTemplate: {} }, [])).toEqual({});
    expect(planGlobalImport({ sidebarCardTemplate: null }, [])).toEqual({});
  });

  it("carries every task-notification key that was authored", () => {
    expect(planYmlImport({
      taskNotifications: { enabled: false, suppressOwnChanges: false, dedupeWindowMs: 0, events: ["created"] },
    }, nothingSet)).toEqual([
      { keyPath: ["taskNotifications", "enabled"], value: false },
      { keyPath: ["taskNotifications", "suppressOwnChanges"], value: false },
      { keyPath: ["taskNotifications", "dedupeWindowMs"], value: 0 },
      { keyPath: ["taskNotifications", "events"], value: ["created"] },
    ]);
  });
});

describe("the marker that makes it run once", () => {
  it("is absent before, present after, and per-workspace", () => {
    const root = makeTempDir("tachyon-import-marker-");
    const marker = settingsImportMarkerPath(root);
    expect(settingsImportAlreadyRan(marker)).toBe(false);
    recordSettingsImport(marker, ["settings.maxAgents"]);
    expect(settingsImportAlreadyRan(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, "utf8")).wrote).toEqual(["settings.maxAgents"]);

    const other = makeTempDir("tachyon-import-marker-");
    expect(settingsImportAlreadyRan(settingsImportMarkerPath(other))).toBe(false);
  });

  it("treats a corrupt marker as 'not proven to have run' — re-running is guarded and harmless", () => {
    const root = makeTempDir("tachyon-import-marker-");
    const marker = settingsImportMarkerPath(root);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "{ not json", "utf8");
    expect(settingsImportAlreadyRan(marker)).toBe(false);
  });
});
