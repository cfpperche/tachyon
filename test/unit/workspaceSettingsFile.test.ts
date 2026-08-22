import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeWorkspaceConfigText,
  migrateLegacyWorkspaceConfig,
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

describe("migrateLegacyWorkspaceConfig", () => {
  it("projects every block to its new home, preserves the original, removes the root file", () => {
    write("tachyon.yml", [
      "agents:",
      "  ghost:",
      "    cmd: claude",
      "terminals:",
      "  test:",
      "    cmd: npm test",
      "schedules:",
      "  nightly:",
      "    spawn: claude",
      "    every: 1h",
      "layouts:",
      "  retired: {}",
      "settings:",
      "  auth: true",
      "  stateBackup:",
      "    backend: filesystem",
      "    path: /mnt/bkp",
    ].join("\n"));
    const result = migrateLegacyWorkspaceConfig(root);
    expect(result.migrated).toBe(true);
    expect(fs.existsSync(path.join(root, "tachyon.yml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon/tachyon.yml.pre-migration"))).toBe(true);
    expect(fs.readFileSync(path.join(root, WORKSPACE_SETTINGS_FILE), "utf8")).toContain("auth: true");
    expect(fs.existsSync(path.join(root, ".tachyon/schedules/nightly.yml"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".tachyon/terminals/test.yml"))).toBe(true);

    // The composed load now sees exactly what the legacy file declared.
    const parsed = parseComposed(composeWorkspaceConfigText(root).yamlText);
    expect(parsed.config?.settings.auth).toBe(true);
    expect(parsed.config?.settings.stateBackup?.path).toBe("/mnt/bkp");
    expect(Object.keys(parsed.config?.schedules ?? {})).toEqual(["nightly"]);

    // Idempotent: nothing left to migrate.
    expect(migrateLegacyWorkspaceConfig(root).migrated).toBe(false);
  });

  it("a legacy file with no settings block still materializes settings.yml — the configured-workspace marker", () => {
    // vsix-smoke on 0.93.30: a terminals-only tachyon.yml migrated into an UNCONFIGURED workspace
    // (no settings.yml → configPath undefined → empty roster). The marker must carry over.
    write("tachyon.yml", "terminals:\n  door:\n    cmd: echo hi\n");
    const result = migrateLegacyWorkspaceConfig(root);
    expect(result.migrated).toBe(true);
    expect(fs.existsSync(path.join(root, WORKSPACE_SETTINGS_FILE))).toBe(true);
    expect(result.actions.some((a) => a.includes(WORKSPACE_SETTINGS_FILE))).toBe(true);
    expect(fs.existsSync(path.join(root, ".tachyon/terminals/door.yml"))).toBe(true);
  });

  it("an existing new-home file wins over the legacy block", () => {
    write(WORKSPACE_SETTINGS_FILE, "auth: false\n");
    write("tachyon.yml", "settings:\n  auth: true\n");
    const result = migrateLegacyWorkspaceConfig(root);
    expect(result.warnings.some((w) => w.includes("already exists and wins"))).toBe(true);
    expect(fs.readFileSync(path.join(root, WORKSPACE_SETTINGS_FILE), "utf8")).toContain("auth: false");
    expect(fs.existsSync(path.join(root, "tachyon.yml"))).toBe(false);
  });

  it("leaves an unparseable legacy file in place and says so", () => {
    write("tachyon.yml", "settings: [unclosed\n");
    const result = migrateLegacyWorkspaceConfig(root);
    expect(result.migrated).toBe(false);
    expect(result.warnings.some((w) => w.includes("not parseable"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tachyon.yml"))).toBe(true);
  });
});
