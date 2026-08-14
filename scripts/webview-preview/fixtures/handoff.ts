/**
 * spec 280 — Handoff-view fixtures for the dev preview harness. Provenance: `synthetic-edge` — typed against
 * the real HandoffViewModel (a drift breaks the build). Covers the populated doc, the cold-start, and a stale state.
 */

import type { HandoffViewModel } from "@tachyon/webview-ui/webview/handoff/handoffViewModel";
import { HANDOFF_DISTILL_PROFILES } from "@tachyon/shared/handoff/distill";
import type { Fixture } from "../routes";

const populated: HandoffViewModel = {
  folder: "tachyon",
  exists: true,
  body: "## Current State\n\nSpec 280 in progress — migrating the 5 pre-existing panels to the shared shell.\n\n## Next Actions\n\n- finish handoff + plugins\n- then sidebar + activity",
  staleness: "fresh",
  pendingCount: 2,
  updatedAt: "2026-06-27T20:00:00.000Z",
  updatedBy: "agent",
  revision: "a1b2c3d",
  distillTargets: [
    { name: "codex", description: "declared agent" },
    { name: "claude", description: "declared agent" },
  ],
  distillProfiles: HANDOFF_DISTILL_PROFILES,
  notes: [
    { ts: "2026-06-27T20:10:00.000Z", agent: "build", kind: "completed", summary: "Lane A shell extension shipped", evidence: ["tachyon a215dc2"] },
    { ts: "2026-06-27T20:20:00.000Z", agent: "build", kind: "next", summary: "migrate handoff + plugins to the shell", evidence: [] },
  ],
};

const cold: HandoffViewModel = { folder: "tachyon", exists: false, body: "", staleness: "fresh", pendingCount: 0, updatedAt: "", updatedBy: "", revision: "", notes: [], distillTargets: [], distillProfiles: populated.distillProfiles };

const stale: HandoffViewModel = { ...populated, staleness: "possibly_stale", updatedAt: "2026-06-20T00:00:00.000Z" };

/** t-4eb7c0 shortlist — Distill target list with Saved + Temporary labels (UI dogfood). */
const distillList: HandoffViewModel = {
  ...populated,
  staleness: "needs_distill",
  pendingCount: 3,
  distillTargets: [
    { name: "codex", description: "declared · running" },
    { name: "grok", description: "declared · running" },
    { name: "claude", description: "declared · idle" },
    { name: "distill-helper", description: "temporary · running" },
  ],
  notes: [
    ...populated.notes,
    { ts: "2026-07-12T16:00:00.000Z", agent: "grok", kind: "gotcha", summary: "Distill list must refresh when Distill opens", evidence: ["t-4eb7c0"] },
  ],
};

export const handoffFixtures: Record<string, Fixture<HandoffViewModel>> = {
  default: { provenance: "synthetic-edge", vm: populated },
  cold: { provenance: "synthetic-edge", vm: cold },
  stale: { provenance: "synthetic-edge", vm: stale },
  "distill-list": { provenance: "synthetic-edge", vm: distillList },
};
