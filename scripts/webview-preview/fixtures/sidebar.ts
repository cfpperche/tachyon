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
};
