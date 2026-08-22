import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { KNOWN_SETTINGS_KEYS } from "@tachyon/engine/config/loadConfig.js";

interface SchemaNode {
  type?: string;
  description?: string;
  additionalProperties?: boolean | SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: SchemaNode;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  default?: unknown;
  dependencies?: Record<string, string[]>;
  /** t-8b8315 — retired keys stay published so a workspace that declares one is told by name. */
  deprecated?: boolean;
}

// t-a65335 — tachyon.yml retired: the settings schema's TOP LEVEL is the settings mapping
// (.tachyon/settings.yml), and terminal/schedule declarations carry their own per-file schemas.
const schemaPath = path.join(process.cwd(), "apps", "vscode-extension", "tachyon.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SchemaNode;
const terminalSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "apps", "vscode-extension", "tachyon-terminal.schema.json"), "utf8")) as SchemaNode;
const scheduleSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "apps", "vscode-extension", "tachyon-schedule.schema.json"), "utf8")) as SchemaNode;
const validateSettings = new Ajv({ allErrors: true }).compile(schema);
const validateTerminal = new Ajv({ allErrors: true }).compile(terminalSchema);
const validateSchedule = new Ajv({ allErrors: true }).compile(scheduleSchema);

const validTerminal = {
  cmd: "npm run dev",
  cwd: ".",
  env: { NODE_ENV: "test" },
  autostart: false,
  watch: ["src/**"],
  attention: { enabled: false, silenceSec: 5, patterns: ["ready"] },
  restart: "on-crash",
};

describe("tachyon.schema.json — settings.companion", () => {
  it("publishes tabTools, allowedHosts, and lanAccess for Companion shells", () => {
    const settings = schema;
    const companion = settings?.properties?.companion;
    const allowedHosts = companion?.properties?.allowedHosts;
    const tabTools = companion?.properties?.tabTools;
    const lanAccess = companion?.properties?.lanAccess;

    expect(companion).toMatchObject({ type: "object", additionalProperties: false });
    expect(companion?.description).toMatch(/Companion/i);
    expect(allowedHosts).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(allowedHosts?.description).toMatch(/host allowlist/i);
    expect(tabTools).toMatchObject({ type: "boolean", default: false });
    expect(tabTools?.description).toMatch(/user_browser_/);
    expect(lanAccess).toMatchObject({ type: "boolean", default: false });
    expect(lanAccess?.description).toMatch(/Tailscale|tailscale|0\.0\.0\.0|loopback/i);
    expect(Object.keys(companion?.properties ?? {}).sort()).toEqual([
      "allowedHosts",
      "lanAccess",
      "tabTools",
    ]);
  });
});

describe("tachyon.schema.json — settings.ideBrowser (SDD 488 F4)", () => {
  it("publishes enabled + homeUrl; tools stay listed when disabled", () => {
    const settings = schema;
    const ideBrowser = settings?.properties?.ideBrowser;
    const enabled = ideBrowser?.properties?.enabled;
    const homeUrl = ideBrowser?.properties?.homeUrl;

    expect(ideBrowser).toMatchObject({ type: "object", additionalProperties: false });
    expect(ideBrowser?.description).toMatch(/Integrated Browser/i);
    expect(enabled).toMatchObject({ type: "boolean", default: false });
    expect(enabled?.description).toMatch(/always remain registered|always remain listed|always listed|Tools always/i);
    expect(homeUrl).toMatchObject({ type: "string", minLength: 1 });
    expect(Object.keys(ideBrowser?.properties ?? {}).sort()).toEqual(["enabled", "homeUrl"]);
  });
});

describe("tachyon.schema.json — settings.projectGuidance", () => {
  it("publishes the closed opt-in file-list contract without an implicit default", () => {
    const settings = schema;
    const guidance = settings?.properties?.projectGuidance;
    const files = guidance?.properties?.files;

    expect(settings?.additionalProperties).toBe(false);
    expect(guidance).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["files"],
    });
    expect(guidance).not.toHaveProperty("default");
    expect(guidance?.description).toContain("project-owned");
    expect(guidance?.description).toContain("source-workspace");

    expect(files).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 256,
      },
    });
  });
});

describe("tachyon.schema.json — settings.checklist.requireIn (t-73885b)", () => {
  it("publishes a free-string list, not an enum", () => {
    const checklist = schema.properties?.checklist;
    const requireIn = checklist?.properties?.requireIn;
    expect(checklist).toMatchObject({ type: "object", additionalProperties: false });
    expect(requireIn).toMatchObject({ type: "array", items: { type: "string", minLength: 1 } });
    expect(requireIn?.items).not.toHaveProperty("enum");
    expect(checklist?.description).toMatch(/free string/i);
    expect(checklist?.description).toMatch(/never blocks/i);
  });
});

describe("tachyon.schema.json — the parser and the editor publish the same keys", () => {
  /**
   * t-fe772a — two closed lists in two files, and only one of them is exercised.
   *
   * `parseConfig` refuses an unrecognized key by name; this schema, bound to `tachyon.yml` by
   * `contributes.yamlValidation`, closes both levels with `additionalProperties: false`. When the
   * schema falls behind, VS Code marks a file the product accepts — the reader trusts the squiggle
   * over the product and edits away a working setting.
   *
   * The recurrence is measured, not feared: on 2026-08-10 the tracked `tachyon.yml.example` itself
   * carried two such keys (`humanInbox` from t-e4f662, `agentNotifications` from t-585d5c), and
   * `agentMemoryMax`, `sidebar`, `handoff`, `persistence`, `bridgeClientRebind` and top-level
   * `schedules` had drifted the same way. Every one of them was added to the parser by someone who
   * did not know this file existed.
   */
  it("publishes exactly the settings keys parseConfig knows", () => {
    // t-a65335 — the settings file's top level IS the settings mapping; KNOWN_TOP_LEVEL_KEYS is the
    // INTERNAL composed-document vocabulary and no longer a published editor contract.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...KNOWN_SETTINGS_KEYS].sort());
  });

  it("publishes exactly the seven terminal keys parseTerminalDeclaration knows", () => {
    expect(Object.keys(terminalSchema.properties ?? {}).sort())
      .toEqual(["attention", "autostart", "cmd", "cwd", "env", "restart", "watch"]);
  });
});

describe("terminal + schedule declaration schemas", () => {
  it("validates a terminal containing all seven parser-supported fields", () => {
    expect(validateTerminal(validTerminal)).toBe(true);
  });

  it("rejects agent-only fields inside a terminal", () => {
    expect(validateTerminal({ cmd: "npm run dev", worktree: true })).toBe(false);
  });

  it("validates a schedule declaration and rejects unknown keys", () => {
    expect(validateSchedule({ every: "30m", spawn: "claude" })).toBe(true);
    expect(validateSchedule({ every: "30m", spawn: "claude", bogus: 1 })).toBe(false);
  });

  it("contains no removed agent schema key anywhere", () => {
    expect(JSON.stringify(schema)).not.toContain("x-removed-agents");
  });

  it("the settings schema validates a top-level settings mapping and refuses unknown keys", () => {
    expect(validateSettings({ auth: true, stateBackup: { backend: "filesystem", path: "/mnt/bkp" } })).toBe(true);
    expect(validateSettings({ terminals: {} })).toBe(false); // declarations no longer live here
  });
});

describe("tachyon.schema.json — retired verify surfaces", () => {
  it("publishes no workspace, worktree, or per-agent execution verify setting", () => {
    const settings = schema;
    const entrySchema = schema.properties?.["x-removed-agents"]?.additionalProperties;
    const agentVerify = typeof entrySchema === "object" ? entrySchema.properties?.verify : undefined;

    expect(settings?.properties?.verify).toBeUndefined();
    expect(settings?.properties?.worktree?.properties?.verify).toBeUndefined();
    expect(agentVerify).toBeUndefined();
  });
});
