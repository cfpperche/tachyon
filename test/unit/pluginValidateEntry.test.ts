import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePluginDir } from "../../apps/vscode-extension/src/pluginValidateEntry.js";

/**
 * t-d8e772 — the validator exists so a plugin AUTHOR can ask the real parser "would Tachyon load
 * this?" before publishing. verify-gate v1.0.0 was tagged and released declaring the parser's OUTPUT
 * shape instead of its input contract, and nothing said so until a human tried to install it.
 *
 * These tests hold the validator to the only standard that matters: it must REFUSE the shapes that
 * would fail at install time. A validator that only confirms healthy packages proves nothing — it is
 * the same false green as a gate that never fires.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function pkg(manifest: unknown, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-validate-test-"));
  dirs.push(root);
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(root, "tachyon-plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

const HOOK_PLUGIN = {
  name: "sample",
  version: "1.0.0",
  description: "a sample package used to exercise the validator",
  gitHooks: { "pre-push": { leaf: "githooks/gate.sh" } },
};

describe("plugin package validator (t-d8e772)", () => {
  it("accepts a package the parser can load", () => {
    const r = validatePluginDir(pkg(HOOK_PLUGIN, { "githooks/gate.sh": "#!/bin/sh\nexit 0\n" }));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ name: "sample", version: "1.0.0" });
  });

  it("REFUSES the exact shape that shipped as verify-gate v1.0.0", () => {
    // `{kind, path}` is what the parser PRODUCES from `leaf` — writing it into the manifest is
    // declaring the output as if it were the input. This is the regression, verbatim.
    const broken = { ...HOOK_PLUGIN, gitHooks: { "pre-push": { kind: "script", path: "githooks/gate.sh" } } };
    const r = validatePluginDir(pkg(broken, { "githooks/gate.sh": "#!/bin/sh\nexit 0\n" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/exactly one of 'leaf'.*or 'argv'/);
  });

  it("REFUSES a declared leaf that is absent from the package", () => {
    // The manifest parses, so the parser alone would pass it; the lie only surfaces at install time,
    // where the fix is a republish rather than an edit.
    const r = validatePluginDir(pkg(HOOK_PLUGIN));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/'githooks\/gate\.sh' is declared but absent/);
  });

  it("REFUSES an unknown git-hook event", () => {
    const broken = { ...HOOK_PLUGIN, gitHooks: { "post-receive": { leaf: "githooks/gate.sh" } } };
    const r = validatePluginDir(pkg(broken, { "githooks/gate.sh": "#!/bin/sh\nexit 0\n" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/post-receive/);
  });

  it("REFUSES invalid JSON instead of treating it as empty", () => {
    const r = validatePluginDir(pkg("{ not json"));
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("REFUSES a directory with no manifest — silence for a missing file proves nothing", () => {
    const r = validatePluginDir(pkg(undefined));
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/no manifest/);
  });

  it("uses the REAL loader, not a copy of the schema", async () => {
    // A second implementation of the contract would drift, and a drifting validator reports green
    // while the loader refuses — strictly worse than having none. Pin the shared dependency.
    const src = fs.readFileSync(path.resolve(__dirname, "../../apps/vscode-extension/src/pluginValidateEntry.ts"), "utf8");
    expect(src).toContain('import { loadManifest } from "@tachyon/engine/plugins/manifest.js"');
    const { loadManifest } = await import("@tachyon/engine/plugins/manifest.js");
    expect(typeof loadManifest).toBe("function");
  });
});
