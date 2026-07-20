/**
 * spec 278 — typed sidebar fixtures for the dev preview harness.
 *
 * Each fixture is a COMPLETE `FleetVM` (every required array present — a missing one crashes
 * searchIndex/countOf; that drift is intentionally fatal and now caught at BUILD because these are
 * typed against `FleetVM`, not plain JS). Each carries a `provenance` label (spec 278): the canonical
 * `default` is `sample-derived` (the real `SAMPLE`), the rest are `synthetic-edge`.
 */

import { SAMPLE, type FleetVM } from "../../../src/sidebar/types";
import type { Fixture } from "../routes";

// a complete FleetVM minus `agents` — every required array present.
const base: Omit<FleetVM, "agents"> = {
  bridge: { port: "42551", connected: true },
  terminals: [],
  pipelines: [],
  proposals: [],
  schedules: [],
  commands: [],
  runbooks: [],
  pins: [],
};

export const sidebarFixtures: Record<string, Fixture<FleetVM>> = {
  // the richest canonical state — the real SAMPLE the production bundle ships.
  default: { provenance: "sample-derived", vm: SAMPLE },

  empty: { provenance: "synthetic-edge", vm: { ...base, agents: [] } },

  // spec 273 — worktree agents carrying non-binary evidence indicators (badge tinting).
  "evidence-badge": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "feature-auth", status: "running", worktree: "tachyon/feature-auth", verify: "pass", verifiable: true, ai: true,
          evidence: { total: 3, stale: 0, warn: 1, error: 0 } },
        { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", verify: "stale", verifiable: true, ai: true,
          evidence: { total: 2, stale: 2, warn: 0, error: 0 } },
        { name: "migration", status: "running", worktree: "tachyon/migration", verify: "fail", verifiable: true, ai: true,
          evidence: { total: 5, stale: 1, warn: 2, error: 1 } },
      ],
    } as FleetVM,
  },

  error: {
    provenance: "synthetic-edge",
    vm: { ...base, agents: [{ name: "migration", status: "crashed", sub: "exited (1)", verify: "fail", verifiable: true, ai: true }] } as FleetVM,
  },

  "declared-owner": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "claude", model: "Opus 4.8", status: "idle", ai: true },
        { name: "codex", model: "GPT-5.1 Codex", status: "running", ai: true },
        { name: "reviewer", model: "Sonnet 5", status: "running", declaredOwner: "claude", ai: true },
        { name: "runtime-reviewer", model: "Sonnet 5", status: "running", parent: "codex", declaredOwner: "claude", ai: true },
        { name: "gated-reviewer", model: "GPT-5.1 Codex", status: "running", delegator: "codex", worktree: "tachyon/gated-reviewer", verify: "stale", verifiable: true, ai: true },
        { name: "orphan-owned", status: "stopped", declaredOwner: "missing-owner", ai: true },
      ],
    } as FleetVM,
  },

  "attention-overflow": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: SAMPLE.agents,
      notices: Array.from({ length: 7 }, (_, index) => ({
        id: `attention-preview-${index + 1}`,
        message: [
          "codex needs a decision on the release boundary",
          "claude completed the visual sweep and is waiting for review",
          "Delivery verification failed at the behavior gate",
          "grok proposed a schedule change for approval",
          "The persistent engine recovered a wedged tmux server",
          "A worktree action requires manual inspection",
          "Queued item promoted after one of the cards is resolved",
        ][index]!,
        level: (["info", "info", "error", "warn", "warn", "error", "info"] as const)[index]!,
        at: new Date(Date.UTC(2026, 6, 19, 20, index)).toISOString(),
        collapsedCount: index === 4 ? 3 : 1,
        actions: index < 2 ? [{ id: `attention-action-${index + 1}`, label: index === 0 ? "Review" : "Open" }] : [],
        read: false,
        actionsLive: index !== 1,
      })),
    } as FleetVM,
  },
};
