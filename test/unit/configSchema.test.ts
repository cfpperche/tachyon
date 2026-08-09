import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("tachyon.schema.json — agents.selfEvolution", () => {
  it("publishes the closed opt-in object without an implicit default", () => {
    const entrySchema = schema.properties?.agents?.additionalProperties;
    const evolution = typeof entrySchema === "object" ? entrySchema.properties?.selfEvolution : undefined;

    expect(evolution).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    });
    expect(evolution).not.toHaveProperty("default");
    expect(evolution?.description).toMatch(/human-reviewed Agent Evolution/i);
  });
});

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
