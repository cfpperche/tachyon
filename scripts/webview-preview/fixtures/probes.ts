/**
 * spec 279 — Probes-view fixtures for the dev preview harness. Provenance: `synthetic-edge` — hand-authored
 * `ProbeView` states (data / empty / error), typed against the real `ProbeView`/`ProbesVM` so a model-shape
 * drift breaks the build. (The probes model is built by the engine's `ProbeStore`; there's no cheap pure
 * builder to capture from, so these are typed synthetic states covering the three render branches.)
 */

import type { ProbeView } from "../../../src/probe/probeView";
import type { ProbesVM } from "../../../src/webview/probes/messages";
import type { Fixture } from "../routes";

const view: ProbeView = {
  total: 6,
  completed: 2,
  failed: 3,
  running: 1,
  empty: false,
  rows: [
    { runId: "p-9f3a21", shortId: "9f3a21", runtime: "claude", archetype: "adversarial-review", caller: "build", status: "completed", reason: "ok", ageLabel: "2m ago", excerpt: "No blocking issues; one nit on error copy.", requestedModel: "claude-opus-5", modelProof: "proven", model: "claude-opus-5-20260101", modelState: "proven", modelTitle: "requested and confirmed claude-opus-5-20260101" },
    { runId: "p-4d02bc", shortId: "4d02bc", runtime: "claude", archetype: "adversarial-review", caller: "review", status: "failed", reason: "model_mismatch", ageLabel: "4m ago", excerpt: "probe requested model 'claude-opus-5' but the runtime reported running claude-haiku-4-5-20251001.", requestedModel: "claude-opus-5", modelProof: "mismatch", model: "claude-haiku-4-5-20251001", modelState: "mismatch", modelTitle: "requested claude-opus-5 — the runtime reported claude-haiku-4-5-20251001" },
    { runId: "p-8e51fa", shortId: "8e51fa", runtime: "codex", archetype: "factual-verify", caller: "build", status: "failed", reason: "model_unproven", ageLabel: "6m ago", excerpt: "the runtime reported no effective model.", requestedModel: "gpt-5.6", modelProof: "unproven", model: "unproven", modelState: "unproven", modelTitle: "requested gpt-5.6; the runtime reported no effective model" },
    { runId: "p-2a77c0", shortId: "2a77c0", runtime: "grok", archetype: "factual-verify", caller: "build", status: "completed", reason: "ok", ageLabel: "7m ago", excerpt: "Claim holds for the cited range.", requestedModel: "—", modelProof: "not-requested", model: "grok-4.5-build", modelState: "reported", modelTitle: "reported grok-4.5-build; no model was requested" },
    { runId: "p-7c11de", shortId: "7c11de", runtime: "claude", archetype: "factual-verify", caller: "review", status: "running", reason: "—", ageLabel: "just now", excerpt: "", requestedModel: "claude-opus-5", modelProof: "unproven", model: "—", modelState: "none", modelTitle: "requested claude-opus-5; still running" },
    { runId: "p-3b88aa", shortId: "3b88aa", runtime: "codex", archetype: "adversarial-review", caller: "build", status: "failed", reason: "timeout", ageLabel: "9m ago", excerpt: "Probe exited (1): provider timeout.", requestedModel: "—", modelProof: "not-requested", model: "—", modelState: "none", modelTitle: "no model requested and none reported" },
  ],
};

const empty: ProbeView = { total: 0, completed: 0, failed: 0, running: 0, empty: true, rows: [] };

export const probesFixtures: Record<string, Fixture<ProbesVM>> = {
  default: { provenance: "synthetic-edge", vm: { folder: "tachyon", view } },
  empty: { provenance: "synthetic-edge", vm: { folder: "tachyon", view: empty } },
  error: { provenance: "synthetic-edge", vm: { folder: "tachyon", error: "EACCES: permission denied reading the probe ledger" } },
};
