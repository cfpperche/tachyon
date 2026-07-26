/**
 * SDD 474 / t-be9405 — headless dogfood for probe model provenance across the adapter fleet.
 *
 * Drives the REAL adapters (their own `interpret`) through the REAL ProbeService/ProbeStore, so the
 * chain under test is: measured runtime payload → adapter extraction → verdict → enforcement →
 * persisted metadata → read surface.
 *
 * Payloads are the ones measured on this machine:
 *   grok 0.2.112     `{"modelUsage":{"grok-4.5-build":{…}}}`
 *   codex-cli 0.145.0 `exec --json` → thread.started / turn.started / item.completed /
 *                     turn.completed, with NO model identity anywhere
 *
 * Run: npm run dogfood:probe-provenance-parity
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeService } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import { codexAdapter } from "../../src/probe/adapters/codex.js";
import { grokAdapter } from "../../src/probe/adapters/grok.js";
import type { HeadlessCaptureAdapter, RawOutcome } from "../../src/probe/adapters/types.js";

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

function raw(stdout: string, resultArtifactText?: string): RawOutcome {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, ...(resultArtifactText ? { resultArtifactText } : {}) } as RawOutcome;
}

/** Run a probe whose runtime output is the measured payload, through the real adapter. */
async function runProbe(adapter: HeadlessCaptureAdapter, outcome: RawOutcome, model?: string) {
  const root = temporaryDir("tachyon-prov-");
  const store = new ProbeStore(root);
  const service = new ProbeService({
    adapters: new Map([[adapter.runtime, adapter]]),
    store,
    // the adapter's OWN interpret runs here — only the process is stubbed out
    runFn: async (a, spec) => a.interpret(outcome, spec),
  });
  const { runId, done } = await service.launch({
    runtime: adapter.runtime,
    archetype: "freeform",
    brief: { prompt: "say ok" } as never,
    ...(model ? { model } : {}),
    cwd: root,
    caller: "dogfood",
  } as never);
  const envelope = await done;
  const meta = JSON.parse(fs.readFileSync(path.join(root, runId, "metadata.json"), "utf8"));
  const rows = await store.list(10);
  return { envelope, meta, row: rows[0] };
}

function grokPayload(modelUsage?: Record<string, unknown>): string {
  return JSON.stringify({
    text: "ok", stopReason: "EndTurn", sessionId: "019fa002-72d6-7d80-b656-455df3429ac3",
    total_cost_usd: 0.0080068, ...(modelUsage ? { modelUsage } : {}),
  });
}

/** Exactly what `codex exec --json` produced, plus the artifact the adapter actually reads. */
const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"019fa001-c77c-7593-ac93-1931cc036f26"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14727,"output_tokens":5}}',
].join("\n");

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];

// ── 1: Grok can now prove a requested model — the exception SDD 473 left open, narrowed.
console.log("\n== 1: grok requested grok-4.5-build, modelUsage confirms it ==");
{
  const { envelope, meta, row } = await runProbe(
    grokAdapter,
    raw(grokPayload({ "grok-4.5-build": { modelCalls: 1 } })),
    "grok-4.5-build",
  );
  checks.push(report(
    "completed, verdict proven, identifier persisted and visible in the listing",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "proven"
    && meta.modelProof === "proven"
    && JSON.stringify(meta.reportedNativeModels) === JSON.stringify(["grok-4.5-build"])
    && row?.modelProof === "proven" && row?.requestedModel === "grok-4.5-build",
    { status: envelope.status, proof: envelope.result?.modelProof, row: { proof: row?.modelProof, requested: row?.requestedModel } },
  ));
}

// ── 2: a Grok fallback is now caught, exactly like Claude's.
console.log("\n== 2: grok requested grok-4-heavy, modelUsage reports grok-4.5-build ==");
{
  const { envelope, meta } = await runProbe(
    grokAdapter,
    raw(grokPayload({ "grok-4.5-build": { modelCalls: 1 } })),
    "grok-4-heavy",
  );
  checks.push(report(
    "failed as model_mismatch naming both models",
    envelope.status === "failed"
    && envelope.result?.reason === "model_mismatch"
    && envelope.result.lastMessage.includes("grok-4-heavy")
    && envelope.result.lastMessage.includes("grok-4.5-build")
    && meta.modelProof === "mismatch",
    { reason: envelope.result?.reason, message: envelope.result?.lastMessage },
  ));
}

// ── 3: a Grok result with no modelUsage no longer passes silently.
console.log("\n== 3: grok requested a model, result carries no modelUsage ==");
{
  const { envelope, meta } = await runProbe(grokAdapter, raw(grokPayload()), "grok-4.5-build");
  checks.push(report(
    "failed as model_unproven; nothing inferred from cost or the requested model",
    envelope.status === "failed"
    && envelope.result?.reason === "model_unproven"
    && meta.modelProof === "unproven"
    && meta.reportedNativeModels === undefined,
    { reason: envelope.result?.reason, proof: envelope.result?.modelProof },
  ));
}

// ── 4: no model requested on grok — nothing to prove, nothing broken.
console.log("\n== 4: grok with no explicit model ==");
{
  const { envelope } = await runProbe(grokAdapter, raw(grokPayload({ "grok-4.5-build": {} })));
  checks.push(report(
    "completes with verdict not-requested",
    envelope.status === "completed" && envelope.result?.modelProof?.verdict === "not-requested",
    { status: envelope.status, verdict: envelope.result?.modelProof?.verdict },
  ));
}

// ── 5: Codex stays honestly exempt on its MEASURED output.
console.log("\n== 5: codex exec --json output carries no model identity ==");
{
  const { envelope, meta, row } = await runProbe(codexAdapter, raw(CODEX_STDOUT, "ok"), "gpt-5.6");
  checks.push(report(
    "result preserved, recorded unproven, and no effective model invented",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "unproven"
    && meta.modelProof === "unproven"
    && meta.reportedNativeModels === undefined
    && envelope.result.modelProof?.effective === undefined
    && row?.modelProof === "unproven",
    { status: envelope.status, proof: envelope.result?.modelProof, metaNative: meta.reportedNativeModels },
  ));
}

// ── 6: the fleet declaration matches reality.
console.log("\n== 6: capability declarations ==");
{
  checks.push(report(
    "grok declares it can prove; codex does not",
    grokAdapter.reportsEffectiveModel === true && codexAdapter.reportsEffectiveModel !== true,
    { grok: grokAdapter.reportsEffectiveModel, codex: codexAdapter.reportsEffectiveModel ?? false },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
