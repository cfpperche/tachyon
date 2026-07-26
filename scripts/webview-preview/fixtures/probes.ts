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
  total: 3,
  completed: 1,
  failed: 1,
  running: 1,
  empty: false,
  rows: [
    { runId: "p-9f3a21", shortId: "9f3a21", runtime: "codex", archetype: "adversarial-review", caller: "build", status: "completed", reason: "review the auth refactor", ageLabel: "2m ago", excerpt: "No blocking issues; one nit on error copy.", requestedModel: "—", modelProof: "not-requested" },
    { runId: "p-7c11de", shortId: "7c11de", runtime: "claude", archetype: "factual-verify", caller: "review", status: "running", reason: "verify the migration claim", ageLabel: "just now", excerpt: "", requestedModel: "claude-opus-5", modelProof: "unproven" },
    { runId: "p-3b88aa", shortId: "3b88aa", runtime: "codex", archetype: "adversarial-review", caller: "build", status: "failed", reason: "review spec 279 plan", ageLabel: "9m ago", excerpt: "Probe exited (1): provider timeout.", requestedModel: "claude-opus-5", modelProof: "mismatch" },
  ],
};

const empty: ProbeView = { total: 0, completed: 0, failed: 0, running: 0, empty: true, rows: [] };

export const probesFixtures: Record<string, Fixture<ProbesVM>> = {
  default: { provenance: "synthetic-edge", vm: { folder: "tachyon", view } },
  empty: { provenance: "synthetic-edge", vm: { folder: "tachyon", view: empty } },
  error: { provenance: "synthetic-edge", vm: { folder: "tachyon", error: "EACCES: permission denied reading the probe ledger" } },
};
