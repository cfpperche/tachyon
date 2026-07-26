/**
 * SDD 476 / t-a10d31 — headless dogfood for Codex effective-model proof, against the REAL CLI.
 *
 * The property under test: a Codex probe that asks for a model can now prove it ran on that model,
 * from Codex's own session record correlated by `thread_id` — and buying that proof did not cost the
 * isolation `--ephemeral` used to provide. Both halves matter: a probe that proved its model by
 * scattering session state through the human's `~/.codex` would be a worse probe, not a better one.
 *
 * Unlike `probe-provenance-parity`, this one SPAWNS codex. It drives the real ProbeService →
 * ProbeRunner → codexAdapter → private CODEX_HOME → rollout correlation chain end to end, and fails
 * loudly if the CLI is absent rather than passing vacuously.
 *
 * Run: npm run dogfood:probe-codex-model-proof
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeService } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";
import { codexAdapter, createCodexAdapter } from "../../src/probe/adapters/codex.js";
import { collectCodexSessionEvidence, humanCodexHome, PRIVATE_HOME_DIRNAME } from "../../src/probe/adapters/codexSessionEvidence.js";
import { resolveModelProof } from "../../src/probe/modelProof.js";
import type { HeadlessCaptureAdapter } from "../../src/probe/adapters/types.js";

/** The model this dogfood asks for. Requested explicitly — never inferred, never defaulted. */
const MODEL = "gpt-5.6-luna";
/** A different real model, used to show a mismatch is caught on real rollout data. */
const OTHER_MODEL = "gpt-5.6-sol";

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

/** Does any file under `root` mention `needle`? Used to prove a session did NOT land somewhere. */
function findFileNamed(root: string, needle: string, depth = 0): string[] {
  if (depth > 8) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) hits.push(...findFileNamed(full, needle, depth + 1));
    else if (entry.name.includes(needle)) hits.push(full);
  }
  return hits;
}

/** A recursive fingerprint of a directory: relative path → size + mtime. Used to prove non-writes. */
function fingerprint(root: string, depth = 0): Record<string, string> {
  const out: Record<string, string> = {};
  if (depth > 8) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of Object.entries(fingerprint(full, depth + 1))) out[`${entry.name}/${k}`] = v;
    } else {
      try {
        const st = fs.statSync(full);
        out[entry.name] = `${st.size}:${st.mtimeMs}`;
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out;
}

const repoRoot = process.cwd();
const humanHome = humanCodexHome();

/** Launch one real Codex probe through the real service and return everything it produced. */
async function runRealProbe(opts: { model?: string; timeoutMs?: number; adapter?: HeadlessCaptureAdapter; root?: string }) {
  const root = opts.root ?? temporaryDir("tachyon-codex-dogfood-");
  const store = new ProbeStore(root);
  const service = new ProbeService({
    adapters: new Map([["codex", opts.adapter ?? codexAdapter]]),
    store,
  });
  const { runId, done } = await service.launch({
    runtime: "codex",
    archetype: "freeform",
    brief: { prompt: "Reply with exactly: ok" } as never,
    ...(opts.model ? { model: opts.model } : {}),
    cwd: repoRoot,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    caller: "dogfood",
  } as never);
  const envelope = await done;
  const meta = JSON.parse(fs.readFileSync(path.join(root, runId, "metadata.json"), "utf8"));
  const rows = await store.list(10);
  return { runId, envelope, meta, root, privateHome: path.join(root, runId, PRIVATE_HOME_DIRNAME), row: rows.find((r) => r.runId === runId) };
}

const checks: boolean[] = [];

// ── 0: this dogfood measures the real CLI; without it there is nothing to measure.
console.log("\n== 0: the real codex CLI is present ==");
let version: string;
try {
  version = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
} catch {
  console.log("FAIL — codex CLI not on PATH; this dogfood measures the real binary and cannot be satisfied without it");
  console.log("\nDOGFOOD FAIL — 0/1 checks passed");
  process.exit(1);
}
checks.push(report("codex is installed", true, version));

// ── 1: the headline — a real run proves the model it asked for, and cleans up after itself.
console.log(`\n== 1: real codex probe requesting ${MODEL} ==`);
const humanBefore = fingerprint(path.join(humanHome, "sessions"));
let provenSessionId = "";
{
  const { envelope, meta, privateHome, row } = await runRealProbe({ model: MODEL });
  provenSessionId = String(envelope.result?.native.sessionId ?? "");
  checks.push(report(
    "completed, verdict proven, effective model persisted, evidence named as the session record",
    envelope.status === "completed"
    && envelope.result?.modelProof?.verdict === "proven"
    && JSON.stringify(envelope.result.modelProof.effective) === JSON.stringify([MODEL])
    && envelope.result.modelProof.evidence === "session-record"
    && meta.modelProof === "proven"
    && meta.modelEvidence === "session-record"
    && row?.effectiveModel === MODEL,
    { status: envelope.status, proof: envelope.result?.modelProof, answer: envelope.result?.lastMessage?.slice(0, 40) },
  ));
  checks.push(report(
    "the run's session id was correlated from the stream, not guessed",
    typeof envelope.result?.native.sessionId === "string" && (envelope.result.native.sessionId as string).length > 8,
    { sessionId: envelope.result?.native.sessionId },
  ));
  checks.push(report(
    "the private codex home is gone — no session state accumulates",
    !fs.existsSync(privateHome),
    { privateHome, exists: fs.existsSync(privateHome) },
  ));
}

// ── 2: the isolation half. Dropping `--ephemeral` must not push session state into the human's home.
//
// Scoped to `sessions/` deliberately. A developer machine runs other codex processes concurrently
// (this repository is driven by codex agents), and `~/.codex/tmp/`, `cache/` and the sqlite WAL files
// churn constantly regardless of what the probe does — a whole-home diff would report their noise as
// ours. `sessions/` is the durable state `--ephemeral` was suppressing, and it is what this spec put
// at risk. Measured separately: with `CODEX_HOME` relocated, even codex's arg0 helper binaries are
// created under the PRIVATE home, not the human's.
console.log("\n== 2: the human's CODEX_HOME was not written ==");
{
  const humanSessions = path.join(humanHome, "sessions");
  const humanAfter = fingerprint(humanSessions);
  const changed = Object.keys({ ...humanBefore, ...humanAfter }).filter((k) => humanBefore[k] !== humanAfter[k]);
  // The exact claim, immune to any concurrent codex: THIS run's session is not in the human's tree.
  const leaked = provenSessionId ? findFileNamed(humanSessions, provenSessionId) : ["<no session id to check>"];
  checks.push(report(
    "the probe's own session is absent from the human's tree, and no session file there changed",
    leaked.length === 0 && changed.length === 0,
    { humanSessions, sessionId: provenSessionId, leaked, changed: changed.slice(0, 5) },
  ));
}

// ── 3: a mismatch is caught — on a REAL rollout, not a hand-written one.
console.log(`\n== 3: a real ${OTHER_MODEL} rollout read against a request for ${MODEL} ==`);
{
  // Keep the private home alive past the run so the real correlation code can be re-read against a
  // different requested model. This is the fallback case with real bytes: same machinery, same files.
  let captured: string | undefined;
  const preserving = createCodexAdapter({ removeHome: async (home) => void (captured = home) });
  const { envelope } = await runRealProbe({ model: OTHER_MODEL, adapter: preserving });
  const evidence = captured ? await collectCodexSessionEvidence(captured, "") : { unavailable: "no home captured" };
  // Re-correlate using the session id the run itself reported, then judge it against the OTHER model.
  const reread = captured
    ? await collectCodexSessionEvidence(captured, JSON.stringify({ type: "thread.started", thread_id: envelope.result?.native.sessionId }))
    : { models: undefined };
  const proof = resolveModelProof({ requested: MODEL, effective: reread.models, evidence: "session-record" });
  checks.push(report(
    `a rollout recording ${OTHER_MODEL} is a mismatch against a request for ${MODEL}`,
    envelope.result?.modelProof?.verdict === "proven"
    && JSON.stringify(reread.models) === JSON.stringify([OTHER_MODEL])
    && proof.verdict === "mismatch",
    { realRunVerdict: envelope.result?.modelProof?.verdict, rereadModels: reread.models, crossVerdict: proof.verdict },
  ));
  checks.push(report(
    "an empty stdout correlates to nothing — the newest rollout is never borrowed",
    evidence.models === undefined && typeof evidence.unavailable === "string",
    { unavailable: evidence.unavailable },
  ));
  if (captured) fs.rmSync(captured, { recursive: true, force: true });
}

// ── 4: concurrency — two real probes at once, each proving its own model from its own home.
console.log(`\n== 4: concurrent probes (${MODEL} and ${OTHER_MODEL}) ==`);
{
  const [a, b] = await Promise.all([runRealProbe({ model: MODEL }), runRealProbe({ model: OTHER_MODEL })]);
  checks.push(report(
    "each run proved its OWN model and neither read the other's rollout",
    a.envelope.result?.modelProof?.verdict === "proven"
    && JSON.stringify(a.envelope.result.modelProof.effective) === JSON.stringify([MODEL])
    && b.envelope.result?.modelProof?.verdict === "proven"
    && JSON.stringify(b.envelope.result.modelProof.effective) === JSON.stringify([OTHER_MODEL])
    && a.envelope.result.native.sessionId !== b.envelope.result.native.sessionId
    && !fs.existsSync(a.privateHome) && !fs.existsSync(b.privateHome),
    { a: a.envelope.result?.modelProof, b: b.envelope.result?.modelProof },
  ));
}

// ── 5: a timeout stays a timeout, and still tears the private home down.
console.log("\n== 5: a probe killed by the wall-clock cap ==");
{
  const { envelope, privateHome } = await runRealProbe({ model: MODEL, timeoutMs: 900 });
  checks.push(report(
    "reason is timeout (not a model failure), and the private home is still removed",
    envelope.status === "failed"
    && envelope.result?.reason === "timeout"
    && !fs.existsSync(privateHome),
    { status: envelope.status, reason: envelope.result?.reason, homeRemoved: !fs.existsSync(privateHome) },
  ));
}

// ── 6: no rollout at all (codex died before writing one) — preserved, unproven, nothing invented.
console.log("\n== 6: an explicit model with no rollout to correlate ==");
{
  const emptyHome = temporaryDir("tachyon-codex-norollout-");
  const stdout = JSON.stringify({ type: "thread.started", thread_id: "019fa07e-f2a7-7da1-a3b9-fe2cebc3884c" });
  const evidence = await collectCodexSessionEvidence(emptyHome, stdout);
  const proof = resolveModelProof({ requested: MODEL, effective: evidence.models, evidence: "session-record" });
  checks.push(report(
    "verdict unproven, no effective model, and the reason is recorded rather than swallowed",
    evidence.models === undefined
    && proof.verdict === "unproven"
    && proof.effective === undefined
    && (evidence.unavailable ?? "").includes("no session rollout"),
    { verdict: proof.verdict, unavailable: evidence.unavailable },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
