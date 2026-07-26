/**
 * SDD 475 / t-3a3de1 — headless dogfood for the Probes model column.
 *
 * Writes real probe artifacts to disk, reads them back through the REAL ProbeStore ledger and the
 * REAL buildProbeView, and asserts what each row's model cell would say. The chain under test is
 * stored provenance → ledger → view model, i.e. the same path the Control table renders from.
 *
 * The property that matters: the cell never prints a REQUESTED model in the position a reader takes
 * for the model that answered.
 *
 * Run: npm run dogfood:probes-model-column
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import { buildProbeView } from "../../src/probe/probeView.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-probes-col-"));

/** Write a stored run exactly as ProbeService would have left it. */
function writeRun(runId: string, meta: Record<string, unknown>, status: string, reason: string): void {
  fs.mkdirSync(path.join(root, runId), { recursive: true });
  fs.writeFileSync(path.join(root, runId, "metadata.json"), JSON.stringify({
    runId, runtime: "claude", adapterVersion: "1", archetype: "freeform", caller: "dogfood",
    createdAt: new Date(Date.parse("2026-07-26T00:00:00Z")).toISOString(),
    finishedAt: new Date(Date.parse("2026-07-26T00:00:10Z")).toISOString(),
    ...meta,
  }));
  fs.writeFileSync(path.join(root, runId, "result.json"), JSON.stringify({
    runId, status,
    result: { reason, lastMessage: "answer", exitCode: 0, timedOut: false, native: { runtime: "claude" } },
  }));
}

// proven — Claude reported the dated release of the requested model
writeRun("probe-proven", {
  requestedModel: "claude-opus-5",
  reportedNativeModels: ["claude-opus-5-20260101"], reportedModels: ["claude-opus-5"],
  modelProof: "proven",
}, "completed", "ok");

// mismatch — the recorded incident: asked opus, ran haiku
writeRun("probe-mismatch", {
  requestedModel: "claude-opus-5",
  reportedNativeModels: ["claude-haiku-4-5-20251001"], reportedModels: ["claude-haiku-4-5"],
  modelProof: "mismatch",
}, "failed", "model_mismatch");

// unproven — a model was requested and the runtime reported none
writeRun("probe-unproven", { requestedModel: "gpt-5.6", modelProof: "unproven" }, "failed", "model_unproven");

// reported — nothing requested, but Grok said what it ran (SDD 474)
writeRun("probe-reported", { runtime: "grok", reportedNativeModels: ["grok-4.5-build"], modelProof: "not-requested" },
  "completed", "ok");

// legacy — stored before any provenance existed
writeRun("probe-legacy", {}, "completed", "ok");

// legacy that DID request a model but proved nothing
writeRun("probe-legacy-req", { requestedModel: "claude-opus-5" }, "completed", "ok");

// canonical-only — an older Claude run kept the family but not the native key
writeRun("probe-canonical", { requestedModel: "claude-opus-5", reportedModels: ["claude-opus-5"], modelProof: "proven" },
  "completed", "ok");

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];
const rows = await new ProbeStore(root).list(20);
const view = buildProbeView(rows, Date.parse("2026-07-26T00:01:00Z"));
const byId = new Map(view.rows.map((r) => [r.runId, r]));

console.log(`\nledger rows: ${view.rows.length}`);
for (const r of view.rows) console.log(`  ${r.runId.padEnd(20)} model=${JSON.stringify(r.model).padEnd(30)} state=${r.modelState}`);

console.log("\n== 1: a proven run shows the effective identifier ==");
{
  const r = byId.get("probe-proven")!;
  checks.push(report(
    "shows the dated identifier the runtime reported, not the requested family",
    r.model === "claude-opus-5-20260101" && r.modelState === "proven",
    { model: r.model, state: r.modelState, requested: r.requestedModel },
  ));
}

console.log("\n== 2: a mismatch shows what RAN, and names the request only in the tooltip ==");
{
  const r = byId.get("probe-mismatch")!;
  checks.push(report(
    "cell is the haiku identifier; 'opus' appears only in the title",
    r.model === "claude-haiku-4-5-20251001" && r.modelState === "mismatch"
    && !r.model.includes("opus") && r.modelTitle.includes("claude-opus-5"),
    { model: r.model, state: r.modelState, title: r.modelTitle },
  ));
}

console.log("\n== 3: an unprovable run never borrows the requested model ==");
{
  const r = byId.get("probe-unproven")!;
  checks.push(report(
    "cell reads 'unproven' and does not contain the requested identifier",
    r.model === "unproven" && r.modelState === "unproven" && !r.model.includes("gpt-5.6")
    && r.modelTitle.includes("gpt-5.6"),
    { model: r.model, state: r.modelState, title: r.modelTitle },
  ));
}

console.log("\n== 4: nothing requested, but the runtime reported a model ==");
{
  const r = byId.get("probe-reported")!;
  checks.push(report(
    "shows grok-4.5-build rather than discarding a real fact",
    r.model === "grok-4.5-build" && r.modelState === "reported",
    { model: r.model, state: r.modelState },
  ));
}

console.log("\n== 5: historical runs are never shown as a model they cannot support ==");
{
  const legacy = byId.get("probe-legacy")!;
  const legacyReq = byId.get("probe-legacy-req")!;
  checks.push(report(
    "no provenance → '—'; requested-but-unprovable → 'unproven', never the requested id",
    legacy.model === "—" && legacy.modelState === "none"
    && legacyReq.model === "unproven" && !legacyReq.model.includes("claude-opus-5"),
    { legacy: legacy.model, legacyRequested: legacyReq.model },
  ));
}

console.log("\n== 6: a pre-474 Claude run falls back to the canonical family ==");
{
  const r = byId.get("probe-canonical")!;
  checks.push(report(
    "uses reportedModels when no native key was stored",
    r.model === "claude-opus-5" && r.modelState === "proven",
    { model: r.model, state: r.modelState },
  ));
}

console.log("\n== 7: no row prints its requested model as the effective one ==");
{
  const offenders = view.rows.filter((r) =>
    r.requestedModel !== "—" && r.model === r.requestedModel && r.modelState !== "proven");
  checks.push(report(
    "the requested identifier never appears in the cell except when it IS the proven effective one",
    offenders.length === 0,
    offenders.length === 0 ? "0 offending rows" : offenders.map((r) => r.runId),
  ));
}

fs.rmSync(root, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
