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

describe("tachyon.schema.json — settings.verify", () => {
  it("publishes a closed project-owned command and named-behavior adapter contract", () => {
    const settings = schema.properties?.settings;
    const verify = settings?.properties?.verify;
    const full = verify?.properties?.full;
    const typecheck = verify?.properties?.typecheck;
    const prepare = verify?.properties?.prepare;
    const affected = verify?.properties?.affected;
    const behavior = verify?.properties?.behavior;
    const adapter = behavior?.properties?.adapter;
    const command = behavior?.properties?.command;
    const stubPath = behavior?.properties?.stubPath;
    const executorPaths = behavior?.properties?.executorPaths;

    expect(verify).toMatchObject({ type: "object", additionalProperties: false });
    expect(verify).not.toHaveProperty("default");
    expect(verify?.description).toContain("Project-owned");
    expect(verify?.description).toContain("no package-manager");
    expect(Object.keys(verify?.properties ?? {}).sort()).toEqual(["affected", "behavior", "full", "prepare", "typecheck"]);
    /**
     * t-8b8315 — `behavior` used to REQUIRE `prepare`, because the retired verify_task provisioned
     * each isolated BASE/HEAD clone before running the named oracle. With the adapter retired and
     * ignored, that dependency only had the power to fail a config over a key the loader discards,
     * so it is gone and `behavior` is published as deprecated instead.
     */
    expect(verify?.dependencies).toBeUndefined();
    expect(behavior?.deprecated).toBe(true);
    expect(behavior?.description).toContain("RETIRED and ignored");

    for (const field of [full, typecheck, prepare, affected]) {
      expect(field).toMatchObject({ type: "string", minLength: 1 });
    }
    expect(behavior).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["adapter", "command", "stubPath", "executorPaths"],
    });
    expect(adapter).toMatchObject({ type: "string", enum: ["vitest-name"] });
    expect(prepare).toMatchObject({ type: "string", minLength: 1 });
    expect(command).toMatchObject({ type: "string", minLength: 1 });
    expect(stubPath).toMatchObject({ type: "string", minLength: 1, maxLength: 512 });
    expect(executorPaths).toMatchObject({ type: "array", minItems: 1, uniqueItems: true });
    expect(stubPath?.pattern).toBeTruthy();

    const safeTemplate = new RegExp(stubPath!.pattern!);
    expect(safeTemplate.test("test/unit/{agent}Behavior.gen.test.ts")).toBe(true);
    for (const unsafe of ["/tmp/{agent}.test.ts", "../{agent}.test.ts", "test\\{agent}.test.ts", ".git/{agent}.test.ts", "test/fixed.test.ts"]) {
      expect(safeTemplate.test(unsafe), unsafe).toBe(false);
    }
  });
});
