/**
 * SDD 474 / t-be9405 — headless dogfood for probe model provenance across the adapter fleet.
 *
 * Drives the REAL adapters (their own `interpret`) through the REAL ProbeService/ProbeStore, so the
 * chain under test is: measured runtime payload → adapter extraction → verdict → enforcement →
 * persisted metadata → read surface.
 *
 * Payloads are the ones measured on this machine:
 *   grok 0.2.112      `{"modelUsage":{"grok-4.5-build":{…}}}`
 *   codex-cli 0.145.0 `exec --json` → thread.started / turn.started / item.completed /
 *                     turn.completed, with NO model identity anywhere — so SDD 476 correlates the
 *                     `thread_id` to the session rollout Codex writes in the probe's PRIVATE home,
 *                     whose `turn_context.payload.model` is the identity. The rollout below is the
 *                     measured shape, written to a real private home the real adapter then reads.
 *
 * Run: node scripts/dogfood/run.mjs probe-provenance-parity
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeService } from "@tachyon/engine/probe/ProbeService.js";
import { ProbeStore } from "@tachyon/engine/probe/ProbeStore.js";
import { codexAdapter } from "@tachyon/engine/probe/adapters/codex.js";
import { PRIVATE_HOME_DIRNAME } from "@tachyon/engine/probe/adapters/codexSessionEvidence.js";
import { grokAdapter } from "@tachyon/engine/probe/adapters/grok.js";
import type { HeadlessCaptureAdapter, Invocation, RawOutcome } from "@tachyon/engine/probe/adapters/types.js";

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
async function runProbe(adapter: HeadlessCaptureAdapter, outcome: RawOutcome, model?: string, onInvocation?: (inv: Invocation) => void) {
  const root = temporaryDir("tachyon-prov-");
  const store = new ProbeStore(root);
  const service = new ProbeService({
    adapters: new Map([[adapter.runtime, adapter]]),
    store,
    // the adapter's OWN buildInvocation + interpret run here — only the process is stubbed out, so
    // Codex still prepares its private home and still reads the rollout out of it (SDD 476).
    runFn: async (a, spec, opts) => {
      const inv = await a.buildInvocation(spec, opts.scratchDir);
      onInvocation?.(inv);
      try {
        return await a.interpret(outcome, spec, inv);
      } finally {
        if (a.cleanup) await a.cleanup(inv).catch(() => undefined);
      }
    },
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

const CODEX_THREAD = "019fa001-c77c-7593-ac93-1931cc036f26";

/** Exactly what `codex exec --json` produced, plus the artifact the adapter actually reads. */
const CODEX_STDOUT = [
  `{"type":"thread.started","thread_id":"${CODEX_THREAD}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14727,"output_tokens":5}}',
].join("\n");

/**
 * The measured rollout shape, written where codex writes it inside the probe's own private home:
 * `sessions/<y>/<m>/<d>/rollout-<ts>-<session_id>.jsonl`. The model lives in `turn_context`, and
 * `session_meta` repeats the session id so the file has to identify itself as this run.
 */
function writeCodexRollout(inv: Invocation, sessionId: string, model?: string): void {
  const home = inv.env?.CODEX_HOME;
  if (!home || path.basename(home) !== PRIVATE_HOME_DIRNAME) throw new Error("codex probe did not prepare a private home");
  const dir = path.join(home, "sessions", "2026", "07", "26");
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, id: sessionId, cli_version: "0.145.0", originator: "codex_exec" } }),
    ...(model ? [JSON.stringify({ type: "turn_context", payload: { turn_id: "t0", model, effort: "medium" } })] : []),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258400 } } }),
  ];
  fs.writeFileSync(path.join(dir, `rollout-2026-07-26T19-15-02-${sessionId}.jsonl`), records.join("\n"));
}

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

// ── 5: Codex proves its model from its own session record — the exemption SDD 474 recorded, closed.
console.log("\n== 5: codex correlates its rollout by thread_id and proves the requested model ==");
{
  const { envelope, meta, row } = await runProbe(
    codexAdapter, raw(CODEX_STDOUT, "ok"), "gpt-5.6-luna",
    (inv) => writeCodexRollout(inv, CODEX_THREAD, "gpt-5.6-luna"),
  );
  checks.push(report(
    "completed, verdict proven, identifier persisted, evidence named as the session record",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "proven"
    && JSON.stringify(meta.reportedNativeModels) === JSON.stringify(["gpt-5.6-luna"])
    && envelope.result.modelProof.evidence === "session-record"
    && meta.modelEvidence === "session-record"
    && row?.modelProof === "proven" && row?.effectiveModel === "gpt-5.6-luna",
    { status: envelope.status, proof: envelope.result?.modelProof, row: { proof: row?.modelProof, effective: row?.effectiveModel } },
  ));
}

// ── 6: a codex fallback is caught, exactly like Claude's and Grok's.
console.log("\n== 6: codex requested gpt-5.6-luna, the rollout records gpt-5.6-sol ==");
{
  const { envelope, meta } = await runProbe(
    codexAdapter, raw(CODEX_STDOUT, "ok"), "gpt-5.6-luna",
    (inv) => writeCodexRollout(inv, CODEX_THREAD, "gpt-5.6-sol"),
  );
  checks.push(report(
    "failed as model_mismatch naming both models",
    envelope.status === "failed"
    && envelope.result?.reason === "model_mismatch"
    && envelope.result.lastMessage.includes("gpt-5.6-luna")
    && envelope.result.lastMessage.includes("gpt-5.6-sol")
    && meta.modelProof === "mismatch",
    { reason: envelope.result?.reason, message: envelope.result?.lastMessage },
  ));
}

// ── 7: no rollout to correlate → unproven, and nothing is borrowed from a neighbour.
console.log("\n== 7: codex wrote no rollout for this run's thread id ==");
{
  const { envelope, meta } = await runProbe(codexAdapter, raw(CODEX_STDOUT, "ok"), "gpt-5.6-luna");
  checks.push(report(
    "failed as model_unproven; the answer survives but proves nothing",
    envelope.status === "failed"
    && envelope.result?.reason === "model_unproven"
    && meta.modelProof === "unproven"
    && meta.reportedNativeModels === undefined
    && envelope.result.modelProof?.effective === undefined
    && String(envelope.result.native.modelEvidenceUnavailable).includes("no session rollout"),
    { reason: envelope.result?.reason, unavailable: envelope.result?.native.modelEvidenceUnavailable },
  ));
}

// ── 8: a rollout that belongs to a DIFFERENT session is refused, however convenient it is.
console.log("\n== 8: the only rollout present names another session ==");
{
  const { envelope, meta } = await runProbe(
    codexAdapter, raw(CODEX_STDOUT, "ok"), "gpt-5.6-luna",
    (inv) => writeCodexRollout(inv, "019fa080-84b3-75d0-ae7c-cb911d01f83d", "gpt-5.6-luna"),
  );
  checks.push(report(
    "unproven — correlation is by thread id, never 'the rollout that happens to be there'",
    envelope.result?.modelProof?.verdict === "unproven" && meta.reportedNativeModels === undefined,
    { verdict: envelope.result?.modelProof?.verdict, unavailable: envelope.result?.native.modelEvidenceUnavailable },
  ));
}

// ── 9: the fleet declaration matches reality.
console.log("\n== 9: capability declarations ==");
{
  checks.push(report(
    "every adapter proves its model, and each names the KIND of evidence it can support",
    grokAdapter.reportsEffectiveModel === true && codexAdapter.reportsEffectiveModel === true
    && grokAdapter.modelEvidence === "provider-usage" && codexAdapter.modelEvidence === "session-record",
    { grok: { proves: grokAdapter.reportsEffectiveModel, evidence: grokAdapter.modelEvidence },
      codex: { proves: codexAdapter.reportsEffectiveModel, evidence: codexAdapter.modelEvidence } },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
