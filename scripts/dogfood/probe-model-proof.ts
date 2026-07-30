/**
 * SDD 473 / t-37fb51 — headless dogfood for probe effective-model proof.
 *
 * The property under test: a probe is read as evidence, so it must never present as a clean success
 * when the model that actually ran was not the model that was requested — and must never look
 * proven when nothing proved it.
 *
 * Reproduces the recorded incidents end to end through the real ProbeService + ProbeStore, with a
 * stubbed runner standing in for the CLI so the adapter's parsed output is the only variable:
 *   probe-66c1e789 / probe-42744006 — asked claude-opus-5, modelUsage proved claude-haiku-4-5
 *   probe-77505e6b — asked claude-opus-5, completed at $0.2126, recorded no model at all
 *
 * Run: npm run dogfood -- probe-model-proof
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeService } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import type { HeadlessCaptureAdapter } from "../../src/probe/adapters/types.js";
import type { ProbeResult } from "../../src/probe/taxonomy.js";

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

/** An adapter whose interpretation is fixed by the scenario — the CLI itself is not under test. */
function stubAdapter(runtime: string, reportsEffectiveModel: boolean, result: ProbeResult): HeadlessCaptureAdapter {
  return {
    runtime,
    adapterVersion: "dogfood-1",
    reportsEffectiveModel,
    buildInvocation: () => ({ bin: runtime, args: [] }),
    interpret: () => result,
    detectCapability: async () => ({ runtime, available: true, version: "dogfood" }),
  } as unknown as HeadlessCaptureAdapter;
}

function claudeResult(modelUsage?: Record<string, { canonicalModel?: string }>): ProbeResult {
  const keys = modelUsage ? Object.keys(modelUsage) : [];
  const canonical = modelUsage
    ? Object.values(modelUsage).map((v) => v.canonicalModel).filter((v): v is string => Boolean(v))
    : [];
  return {
    reason: "ok",
    lastMessage: "the review says the change is fine",
    exitCode: 0,
    timedOut: false,
    costUsd: 0.2126,
    native: {
      runtime: "claude",
      subtype: "success",
      ...(keys.length > 0 ? { reportedNativeModels: keys } : {}),
      ...(canonical.length > 0 ? { reportedModels: canonical } : {}),
    },
  };
}

async function runProbe(opts: {
  runtime: string;
  reportsEffectiveModel: boolean;
  result: ProbeResult;
  model?: string;
}) {
  const root = temporaryDir("tachyon-probe-proof-");
  const store = new ProbeStore(root);
  const service = new ProbeService({
    adapters: new Map([[opts.runtime, stubAdapter(opts.runtime, opts.reportsEffectiveModel, opts.result)]]),
    store,
    runFn: async () => opts.result,
  });
  const { runId, done } = await service.launch({
    runtime: opts.runtime,
    archetype: "freeform",
    brief: { prompt: "say something" } as never,
    ...(opts.model ? { model: opts.model } : {}),
    cwd: root,
    caller: "dogfood",
  } as never);
  const envelope = await done;
  const meta = JSON.parse(fs.readFileSync(path.join(root, runId, "metadata.json"), "utf8"));
  return { runId, envelope, meta, service, store };
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];

// ── 1: the recorded fallback — asked opus, ran haiku.
console.log("\n== 1: requested claude-opus-5, runtime reports claude-haiku-4-5-20251001 ==");
{
  const { envelope, meta } = await runProbe({
    runtime: "claude",
    reportsEffectiveModel: true,
    model: "claude-opus-5",
    result: claudeResult({ "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5" } }),
  });
  checks.push(report(
    "failed as model_mismatch, naming both models; NOT completed",
    envelope.status === "failed"
    && envelope.result?.reason === "model_mismatch"
    && envelope.result.lastMessage.includes("claude-opus-5")
    && envelope.result.lastMessage.includes("claude-haiku-4-5-20251001")
    && meta.modelProof === "mismatch",
    { status: envelope.status, reason: envelope.result?.reason, metaProof: meta.modelProof, message: envelope.result?.lastMessage },
  ));
}

// ── 2: the recorded silent success — asked opus, nothing reported.
console.log("\n== 2: requested claude-opus-5, runtime reports no model at all ==");
{
  const { envelope, meta } = await runProbe({
    runtime: "claude",
    reportsEffectiveModel: true,
    model: "claude-opus-5",
    result: claudeResult(),
  });
  checks.push(report(
    "failed as model_unproven instead of a $0.21 clean success",
    envelope.status === "failed"
    && envelope.result?.reason === "model_unproven"
    && meta.modelProof === "unproven",
    { status: envelope.status, reason: envelope.result?.reason, metaProof: meta.modelProof },
  ));
}

// ── 3: the honest pass.
console.log("\n== 3: requested claude-opus-5, runtime confirms a dated opus-5 release ==");
{
  const { envelope, meta } = await runProbe({
    runtime: "claude",
    reportsEffectiveModel: true,
    model: "claude-opus-5",
    result: claudeResult({ "claude-opus-5-20260101": { canonicalModel: "claude-opus-5" } }),
  });
  checks.push(report(
    "completed, verdict proven, both identities persisted",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "proven"
    && meta.modelProof === "proven"
    && JSON.stringify(meta.reportedNativeModels) === JSON.stringify(["claude-opus-5-20260101"])
    && JSON.stringify(meta.reportedModels) === JSON.stringify(["claude-opus-5"]),
    { status: envelope.status, proof: envelope.result?.modelProof, native: meta.reportedNativeModels, canonical: meta.reportedModels },
  ));
}

// ── 4: no model requested — nothing to prove, nothing broken.
console.log("\n== 4: no explicit model requested ==");
{
  const { envelope, meta } = await runProbe({
    runtime: "claude",
    reportsEffectiveModel: true,
    result: claudeResult({ "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5" } }),
  });
  checks.push(report(
    "completes normally with verdict not-requested",
    envelope.status === "completed" && envelope.result?.modelProof?.verdict === "not-requested" && meta.modelProof === "not-requested",
    { status: envelope.status, proof: envelope.result?.modelProof?.verdict, metaProof: meta.modelProof },
  ));
}

// ── 5: the documented temporary exemption — a runtime that cannot report.
// The whole fleet can prove its model since SDD 476, so this scenario now guards the CONTRACT rather
// than a named runtime: whatever the next adapter is, an honest "cannot report" must stay readable.
console.log("\n== 5: explicit model on a runtime that cannot report ==");
{
  const { envelope, meta } = await runProbe({
    runtime: "codex",
    reportsEffectiveModel: false,
    model: "gpt-5.6",
    result: { reason: "ok", lastMessage: "ok", exitCode: 0, timedOut: false, native: { runtime: "codex" } },
  });
  checks.push(report(
    "result preserved for compatibility, but persisted unproven and never inferred",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "unproven"
    && meta.modelProof === "unproven"
    && meta.reportedNativeModels === undefined
    && envelope.result.modelProof?.effective === undefined,
    { status: envelope.status, proof: envelope.result?.modelProof, metaNative: meta.reportedNativeModels },
  ));
}

// ── 6: history is not retroactively blessed.
console.log("\n== 6: a run stored before this verdict existed ==");
{
  const root = temporaryDir("tachyon-probe-legacy-");
  const runId = "probe-legacy-0000";
  fs.mkdirSync(path.join(root, runId), { recursive: true });
  // Exactly the shape of the reported artifacts: no requestedModel, no model evidence.
  fs.writeFileSync(path.join(root, runId, "metadata.json"), JSON.stringify({
    runId, runtime: "claude", adapterVersion: "old", archetype: "freeform",
    caller: "codex", createdAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  }));
  fs.writeFileSync(path.join(root, runId, "result.json"), JSON.stringify({
    runId, status: "completed",
    result: { reason: "ok", lastMessage: "historical answer", exitCode: 0, timedOut: false, native: { runtime: "claude" } },
  }));
  const service = new ProbeService({ adapters: new Map(), store: new ProbeStore(root) });
  const envelope = await service.read(runId as never);
  const rows = await new ProbeStore(root).list(10);
  checks.push(report(
    "reads as not-requested/unproven — never proven, and the stored artifact is untouched",
    envelope?.result?.modelProof?.verdict === "not-requested"
    && envelope?.result?.modelProof?.effective === undefined
    && rows[0]?.modelProof === "not-requested"
    && !JSON.parse(fs.readFileSync(path.join(root, runId, "result.json"), "utf8")).result.modelProof,
    { verdict: envelope?.result?.modelProof?.verdict, row: rows[0]?.modelProof },
  ));
}

// ── 7: a historical run that DID request a model but proved nothing.
console.log("\n== 7: a historical run with a requested model and no evidence ==");
{
  const root = temporaryDir("tachyon-probe-legacy2-");
  const runId = "probe-legacy-0001";
  fs.mkdirSync(path.join(root, runId), { recursive: true });
  fs.writeFileSync(path.join(root, runId, "metadata.json"), JSON.stringify({
    runId, runtime: "claude", adapterVersion: "old", archetype: "freeform", caller: "codex",
    requestedModel: "claude-opus-5",
    createdAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(),
  }));
  fs.writeFileSync(path.join(root, runId, "result.json"), JSON.stringify({
    runId, status: "completed",
    result: { reason: "ok", lastMessage: "historical answer", exitCode: 0, timedOut: false, native: { runtime: "claude" } },
  }));
  const envelope = await new ProbeService({ adapters: new Map(), store: new ProbeStore(root) }).read(runId as never);
  const rows = await new ProbeStore(root).list(10);
  checks.push(report(
    "reads as unproven — an old Opus-requested result cannot be cited as proof",
    envelope?.result?.modelProof?.verdict === "unproven" && rows[0]?.modelProof === "unproven",
    { verdict: envelope?.result?.modelProof?.verdict, row: rows[0]?.modelProof, requested: rows[0]?.requestedModel },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
