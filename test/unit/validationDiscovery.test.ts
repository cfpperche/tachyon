import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { discoverValidationCandidates } from "../../src/validations/discovery.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("discoverValidationCandidates", () => {
  it("discovers the same task and pin candidates whether docs/specs exists or not", () => {
    const root = makeTempDir("tachyon-validation-discovery-");
    fs.mkdirSync(path.join(root, ".tachyon", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "tasks", "t-123abc.json"), JSON.stringify({ id: "t-123abc", body: "dogfood pendente no build instalado" }), "utf8");
    fs.writeFileSync(path.join(root, ".tachyon", "pins.json"), JSON.stringify([{ id: "p-123abc", text: "Manual QA for the installed build" }]), "utf8");

    const withoutSpecs = discoverValidationCandidates(root);
    fs.mkdirSync(path.join(root, "docs", "specs", "123-demo"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "specs", "123-demo", "tasks.md"), "**Human dogfood:** Install and check the UI\n", "utf8");
    const withSpecs = discoverValidationCandidates(root, 101);

    expect(withSpecs).toEqual(withoutSpecs);
    expect(withSpecs.map((candidate) => candidate.source_ref)).toEqual([
      { type: "task", ref: "t-123abc" },
      { type: "pin", ref: "p-123abc" },
    ]);
    expect(fs.existsSync(path.join(root, ".tachyon", "validations"))).toBe(false);
  });
});
