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
  default?: unknown;
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
