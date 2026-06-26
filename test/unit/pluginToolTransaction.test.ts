import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolTransaction, gcAbandonedTransactions, TRANSACTIONS_REL } from "../../src/plugins/toolTransaction.js";
import { resolveToolPlaceholders, containsToolPlaceholder } from "../../src/plugins/toolPlaceholder.js";

describe("ToolTransaction + gcAbandonedTransactions", () => {
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

  it("GC reclaims a transaction older than the TTL but keeps a fresh one", () => {
    const old = ToolTransaction.begin(ws, { plugin: "cg", txid: "old", startedAtIso: "2026-06-20T00:00:00.000Z" });
    const fresh = ToolTransaction.begin(ws, { plugin: "cg", txid: "fresh", startedAtIso: "2026-06-25T11:59:00.000Z" });
    const now = Date.parse("2026-06-25T12:00:00.000Z");
    const { reclaimed } = gcAbandonedTransactions(ws, { nowMs: now, ttlMs: 60 * 60 * 1000 });
    expect(fs.existsSync(old.dir)).toBe(false);
    expect(fs.existsSync(fresh.dir)).toBe(true);
    expect(reclaimed).toHaveLength(1);
  });

  it("GC reclaims a transaction with corrupt/missing meta", () => {
    const tx = ToolTransaction.begin(ws, { plugin: "cg", txid: "corrupt", startedAtIso: "2026-06-25T11:59:00.000Z" });
    fs.writeFileSync(path.join(tx.dir, "meta.json"), "{not json");
    const { reclaimed } = gcAbandonedTransactions(ws, { nowMs: Date.parse("2026-06-25T12:00:00.000Z"), ttlMs: 60 * 60 * 1000 });
    expect(fs.existsSync(tx.dir)).toBe(false);
    expect(reclaimed).toHaveLength(1);
  });

  it("GC sweeps stale *.staging-* litter", () => {
    fs.mkdirSync(path.join(ws, TRANSACTIONS_REL, "x.staging-123"), { recursive: true });
    const { reclaimed } = gcAbandonedTransactions(ws, {});
    expect(reclaimed.some((p) => p.includes(".staging-"))).toBe(true);
  });

  it("GC is a no-op when there is no transactions dir", () => {
    expect(gcAbandonedTransactions(ws, {})).toEqual({ reclaimed: [] });
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
