import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeWorkspaceConfigText,
  WORKSPACE_SETTINGS_FILE,
} from "@tachyon/engine/config/workspaceSettingsFile.js";
import {
  scanScheduleDeclarations,
  upsertScheduleDeclaration,
  deleteScheduleDeclaration,
} from "@tachyon/engine/config/scheduleDeclarations.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";

const ROSTER = {
  claude: {
    cmd: "claude",
    kind: "agent" as const,
    autostart: false,
    watch: [],
    attention: { enabled: true, silenceSec: 8, patterns: [] },
    restart: "never" as const,
  },
};
const parseComposed = (text: string) => parseConfig(text, { canonicalAgents: ROSTER });

let root: string;

function write(rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-settings-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("composeWorkspaceConfigText", () => {
  it("synthesizes the parser document from .tachyon/settings.yml + .tachyon/schedules/*.yml", () => {
    write(WORKSPACE_SETTINGS_FILE, "auth: true\nstateBackup:\n  backend: filesystem\n  path: /mnt/bkp\n");
    upsertScheduleDeclaration(root, "nightly", { spawn: "claude", every: "1h", instructions: "do it" });
    const composed = composeWorkspaceConfigText(root);
    expect(composed.errors).toEqual([]);
    const parsed = parseComposed(composed.yamlText);
    expect(parsed.config?.settings.auth).toBe(true);
    expect(parsed.config?.settings.stateBackup?.path).toBe("/mnt/bkp");
    expect(Object.keys(parsed.config?.schedules ?? {})).toEqual(["nightly"]);
  });

  it("absent files compose an empty, valid document", () => {
    const composed = composeWorkspaceConfigText(root);
    expect(composed.errors).toEqual([]);
    expect(parseConfig(composed.yamlText).config).toBeDefined();
  });

  it("reports invalid settings YAML as an error naming the file", () => {
    write(WORKSPACE_SETTINGS_FILE, "auth: [unclosed\n");
    const composed = composeWorkspaceConfigText(root);
    expect(composed.errors.some((e) => e.includes(".tachyon/settings.yml"))).toBe(true);
  });

  it("drops a malformed schedule file with a warning, keeping the rest", () => {
    upsertScheduleDeclaration(root, "good", { every: "1h", spawn: "claude" });
    write(".tachyon/schedules/bad.yml", "- a list, not a mapping\n");
    const composed = composeWorkspaceConfigText(root);
    expect(composed.warnings.some((w) => w.includes("bad.yml"))).toBe(true);
    expect(Object.keys(parseComposed(composed.yamlText).config?.schedules ?? {})).toEqual(["good"]);
  });
});

describe("scheduleDeclarations", () => {
  it("round-trips upsert/scan/delete", () => {
    upsertScheduleDeclaration(root, "s1", { every: "30m", agent: "claude" });
    expect(scanScheduleDeclarations(root).declarations.s1?.every).toBe("30m");
    expect(() => upsertScheduleDeclaration(root, "s1", { every: "1h" })).toThrow(/already exists/);
    upsertScheduleDeclaration(root, "s1", { every: "1h" }, { overwrite: true });
    expect(scanScheduleDeclarations(root).declarations.s1?.every).toBe("1h");
    deleteScheduleDeclaration(root, "s1");
    expect(scanScheduleDeclarations(root).declarations).toEqual({});
  });
});

describe("t-987825 — the legacy file is simply not read any more", () => {
  it("a tachyon.yml at the root contributes nothing and is left alone", () => {
    // The one-shot migration existed for a single upgrade; every workspace that needed it took it.
    // What replaces it is nothing: the product neither reads the file nor touches it, so a stray
    // one is inert rather than a second definition of the format waiting to disagree.
    write("tachyon.yml", "settings:\n  auth: false\nterminals:\n  ghost:\n    cmd: sh\n");
    write(WORKSPACE_SETTINGS_FILE, "auth: true\n");

    const parsed = parseComposed(composeWorkspaceConfigText(root).yamlText);
    expect(parsed.config?.settings.auth).toBe(true);              // the settings file wins because it is the only source
    expect(parsed.config?.agents.ghost).toBeUndefined(); // the legacy terminals block is invisible
    expect(fs.existsSync(path.join(root, "tachyon.yml"))).toBe(true); // and nothing deleted it
  });

  it("a workspace with only a legacy file reads as unconfigured", () => {
    write("tachyon.yml", "settings:\n  auth: true\n");
    expect(fs.existsSync(path.join(root, WORKSPACE_SETTINGS_FILE))).toBe(false);
    const composed = composeWorkspaceConfigText(root);
    expect(composed.errors).toEqual([]);
    expect(composed.yamlText.trim()).toBe("{}");
  });
});
