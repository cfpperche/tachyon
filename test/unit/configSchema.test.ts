import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface SchemaNode {
  type?: string;
  description?: string;
  additionalProperties?: boolean;
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
}

const schemaPath = path.join(process.cwd(), "src", "config", "tachyon.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as SchemaNode;

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
    expect(verify?.dependencies).toEqual({ behavior: ["prepare"] });

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
