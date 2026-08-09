import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolTransaction } from "../../src/plugins/toolTransaction.js";
import { resolveToolPlaceholders, containsToolPlaceholder } from "../../src/plugins/toolPlaceholder.js";

describe("ToolTransaction", () => {
  let ws: string;
  beforeEach(() => (ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-tx-"))));
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("begins a transaction with meta + staging + journal", () => {
    const tx = ToolTransaction.begin(ws, { plugin: "cg", txid: "abc123", startedAtIso: "2026-06-25T00:00:00.000Z" });
    expect(fs.existsSync(tx.stagingDir())).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(tx.dir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ txid: "abc123", plugin: "cg", startedAtIso: "2026-06-25T00:00:00.000Z" });
    tx.appendJournal({ step: "download", tool: "gitleaks" });
    expect(fs.readFileSync(path.join(tx.dir, "journal.jsonl"), "utf8")).toMatch(/download/);
  });

  it("abandon removes the transaction dir", () => {
    const tx = ToolTransaction.begin(ws, { plugin: "cg", txid: "gone" });
    expect(fs.existsSync(tx.dir)).toBe(true);
    tx.abandon();
    expect(fs.existsSync(tx.dir)).toBe(false);
  });
});

describe("resolveToolPlaceholders", () => {
  const opts = { pluginName: "cg", provisionedTools: new Set(["gitleaks"]), launcherPath: "/ws/.tachyon/bin/_tachyon-tool" };

  it("expands a whole-token ${tool:name} to a plugin-scoped launcher invocation", () => {
    const r = resolveToolPlaceholders(["${tool:gitleaks}", "protect", "--staged"], opts);
    expect(r).toEqual({ argv: ["/ws/.tachyon/bin/_tachyon-tool", "cg", "gitleaks", "protect", "--staged"] });
  });

  it("leaves a non-placeholder argv untouched", () => {
    expect(resolveToolPlaceholders(["echo", "hi"], opts)).toEqual({ argv: ["echo", "hi"] });
  });

  it("fails closed on a tool not provisioned by this plugin", () => {
    const r = resolveToolPlaceholders(["${tool:trufflehog}"], opts);
    expect("error" in r && /provisions no tool 'trufflehog'/.test(r.error)).toBe(true);
  });

  it("fails closed on a substring (non-whole-token) use", () => {
    const r = resolveToolPlaceholders(["--bin=${tool:gitleaks}"], opts);
    expect("error" in r && /WHOLE argv token/.test(r.error)).toBe(true);
  });

  it("containsToolPlaceholder catches a placeholder in a script leaf", () => {
    expect(containsToolPlaceholder("#!/bin/sh\nexec ${tool:gitleaks}\n")).toBe(true);
    expect(containsToolPlaceholder("#!/bin/sh\necho hi\n")).toBe(false);
  });
});
