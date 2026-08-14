import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlugin } from "../../apps/vscode-extension/src/plugins/engine.js";

const SHA = "a".repeat(64);

describe("git-hook ${tool:} resolution at load (spec 265 task 10c)", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-th-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeManifest(m: object): void {
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify(m));
  }
  const toolDecl = { version: "1.0.0", platforms: { "linux-x64-glibc": { url: "https://x.io/t", sha256: SHA } } };

  it("resolves a ${tool:name} argv leaf to a plugin-scoped launcher invocation", () => {
    writeManifest({
      name: "cg", version: "1.0.0", description: "d",
      gitHooks: { "pre-commit": { argv: ["${tool:gitleaks}", "protect", "--staged"] } },
      tools: { gitleaks: toolDecl },
    });
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin!.gitHooks[0].argv).toEqual([".tachyon/bin/_tachyon-tool", "cg", "gitleaks", "protect", "--staged"]);
    // The materialized leaf pins the canonical launcher, resolves the main-worktree
    // fallback when needed, and executes only the resulting bounded path.
    const content = plugin!.gitHooks[0].content.toString();
    expect(content).toContain("CMD='.tachyon/bin/_tachyon-tool'");
    expect(content).toContain('exec "$CMD"');
  });

  it("fails closed when ${tool:} names an undeclared tool", () => {
    writeManifest({
      name: "cg", version: "1.0.0", description: "d",
      gitHooks: { "pre-commit": { argv: ["${tool:trufflehog}"] } },
      tools: { gitleaks: toolDecl },
    });
    const { plugin, errors } = loadPlugin(dir);
    expect(plugin).toBeUndefined();
    expect(errors.some((e) => /provisions no tool 'trufflehog'/.test(e))).toBe(true);
  });

  it("fails closed on a ${tool:} substring (not a whole token)", () => {
    writeManifest({
      name: "cg", version: "1.0.0", description: "d",
      gitHooks: { "pre-commit": { argv: ["--bin=${tool:gitleaks}"] } },
      tools: { gitleaks: toolDecl },
    });
    const { errors } = loadPlugin(dir);
    expect(errors.some((e) => /WHOLE argv token/.test(e))).toBe(true);
  });

  it("fails closed when a SCRIPT leaf contains ${tool:...}", () => {
    writeManifest({
      name: "cg", version: "1.0.0", description: "d",
      gitHooks: { "pre-commit": { leaf: "githooks/scan.sh" } },
      tools: { gitleaks: toolDecl },
    });
    fs.mkdirSync(path.join(dir, "githooks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "githooks", "scan.sh"), "#!/bin/sh\nexec ${tool:gitleaks}\n");
    const { errors } = loadPlugin(dir);
    expect(errors.some((e) => /only allowed in an argv leaf/.test(e))).toBe(true);
  });

  it("leaves a plain argv leaf (no placeholder) unchanged", () => {
    writeManifest({
      name: "cg", version: "1.0.0", description: "d",
      gitHooks: { "pre-commit": { argv: ["gitleaks", "protect"] } },
    });
    const { plugin, errors } = loadPlugin(dir);
    expect(errors).toEqual([]);
    expect(plugin!.gitHooks[0].argv).toEqual(["gitleaks", "protect"]);
  });
});
