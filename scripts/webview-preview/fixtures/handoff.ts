/**
 * spec 280 — Handoff-view fixtures for the dev preview harness. Provenance: `synthetic-edge` — typed against
 * the real HandoffViewModel (a drift breaks the build). Covers the populated doc, the cold-start, and a stale state.
 */

import type { HandoffViewModel } from "../../../src/webview/handoff/handoffViewModel";
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
  distillRuntimes: [
    { id: "codex", label: "OpenAI Codex", command: "codex" },
    { id: "claude", label: "Claude Code", command: "claude" },
  ],
  notes: [
    { ts: "2026-06-27T20:10:00.000Z", agent: "build", kind: "completed", summary: "Lane A shell extension shipped", evidence: ["tachyon a215dc2"] },
    { ts: "2026-06-27T20:20:00.000Z", agent: "build", kind: "next", summary: "migrate handoff + plugins to the shell", evidence: [] },
  ],
};

const cold: HandoffViewModel = { folder: "tachyon", exists: false, body: "", staleness: "fresh", pendingCount: 0, updatedAt: "", updatedBy: "", revision: "", notes: [], distillTargets: [], distillRuntimes: populated.distillRuntimes };

const stale: HandoffViewModel = { ...populated, staleness: "possibly_stale", updatedAt: "2026-06-20T00:00:00.000Z" };

export const handoffFixtures: Record<string, Fixture<HandoffViewModel>> = {
  default: { provenance: "synthetic-edge", vm: populated },
  cold: { provenance: "synthetic-edge", vm: cold },
  stale: { provenance: "synthetic-edge", vm: stale },
};
