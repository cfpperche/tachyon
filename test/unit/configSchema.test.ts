import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_SETTINGS_KEYS, KNOWN_TOP_LEVEL_KEYS } from "../../src/config/loadConfig.js";

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

const schemaPath = path.join(process.cwd(), "src", "config", "tachyon.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SchemaNode;

describe("tachyon.schema.json — settings.companion", () => {
  it("publishes tabTools, allowedHosts, and lanAccess for Companion shells", () => {
    const settings = schema.properties?.settings;
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
    const settings = schema.properties?.settings;
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
    const settings = schema.properties?.settings;
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
  it("publishes exactly the top-level and settings keys parseConfig knows", () => {
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...KNOWN_TOP_LEVEL_KEYS].sort());
    expect(Object.keys(schema.properties?.settings?.properties ?? {}).sort()).toEqual([...KNOWN_SETTINGS_KEYS].sort());
  });
});

describe("tachyon.schema.json — retired verify surfaces", () => {
  it("publishes no workspace, worktree, or per-agent execution verify setting", () => {
    const settings = schema.properties?.settings;
    const entrySchema = schema.properties?.agents?.additionalProperties;
    const agentVerify = typeof entrySchema === "object" ? entrySchema.properties?.verify : undefined;

    expect(settings?.properties?.verify).toBeUndefined();
    expect(settings?.properties?.worktree?.properties?.verify).toBeUndefined();
    expect(agentVerify).toBeUndefined();
  });
});
