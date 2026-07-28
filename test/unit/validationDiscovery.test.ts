import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { discoverValidationCandidates } from "../../src/validations/discovery.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("discoverValidationCandidates", () => {
  it("surfaces candidates from specs and tasks without creating validations", () => {
    const root = makeTempDir("tachyon-validation-discovery-");
    fs.mkdirSync(path.join(root, "docs", "specs", "123-demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "specs", "123-demo", "tasks.md"), "**Human dogfood:** Install and check the UI\n", "utf8");
    fs.mkdirSync(path.join(root, ".tachyon", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "tasks", "t-123abc.json"), JSON.stringify({ id: "t-123abc", body: "dogfood pendente no build instalado" }), "utf8");

    const candidates = discoverValidationCandidates(root);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_ref: { type: "sdd", ref: "docs/specs/123-demo" }, executor: "human" }),
      expect.objectContaining({ source_ref: { type: "task", ref: "t-123abc" }, executor: "human" }),
    ]));
    expect(fs.existsSync(path.join(root, ".tachyon", "validations"))).toBe(false);
  });
});
