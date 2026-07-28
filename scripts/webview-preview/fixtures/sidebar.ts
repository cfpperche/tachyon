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
        { name: "feature-auth", status: "running", worktree: "tachyon/feature-auth", verify: "pass", verifiable: true, kind: "agent",
          evidence: { total: 3, stale: 0, warn: 1, error: 0 } },
        { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", verify: "stale", verifiable: true, kind: "agent",
          evidence: { total: 2, stale: 2, warn: 0, error: 0 } },
        { name: "migration", status: "running", worktree: "tachyon/migration", verify: "fail", verifiable: true, kind: "agent",
          evidence: { total: 5, stale: 1, warn: 2, error: 1 } },
      ],
    } as FleetVM,
  },

  // SDD 477 / t-5bfb72 — the state this spec exists for: rows that read "idle" but cannot execute
  // until a human logs the runtime back in. The point of the fixture is the CONTRAST — `sonnet-worker`
  // is genuinely idle and `grok-held` is held, and only the badge tells them apart.
  "auth-required": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "sonnet-worker", model: "Sonnet 5", status: "idle", kind: "agent" },
        { name: "claude-held", model: "Opus 5", status: "idle", kind: "agent",
          authRequired: { runtime: "claude", action: "run /login in the Claude runtime, then restart the agent explicitly" } },
        { name: "grok-held", model: "grok-4", status: "idle", kind: "agent", worktree: "tachyon/grok-held",
          authRequired: { runtime: "grok", action: "run `grok login --device-code`, or set XAI_API_KEY, then restart the agent explicitly" } },
      ],
    } as FleetVM,
  },

  error: {
    provenance: "synthetic-edge",
    vm: { ...base, agents: [{ name: "migration", status: "crashed", sub: "exited (1)", verify: "fail", verifiable: true, kind: "agent" }] } as FleetVM,
  },

  "declared-owner": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "claude", model: "Opus 4.8", status: "idle", kind: "agent" },
        { name: "codex", model: "GPT-5.1 Codex", status: "running", kind: "agent" },
        { name: "reviewer", model: "Sonnet 5", status: "running", declaredOwner: "claude", kind: "agent" },
        { name: "runtime-reviewer", model: "Sonnet 5", status: "running", parent: "codex", declaredOwner: "claude", kind: "agent" },
        { name: "gated-reviewer", model: "GPT-5.1 Codex", status: "running", delegator: "codex", worktree: "tachyon/gated-reviewer", verify: "stale", verifiable: true, kind: "agent" },
        { name: "orphan-owned", status: "stopped", declaredOwner: "missing-owner", kind: "agent" },
      ],
    } as FleetVM,
  },

  // t-fde5b6 — the scroll proof: far more attention than the panel's max-height can show. The panel
  // must stay the same height and scroll internally, never grow or push the rest of the sidebar.
  // t-0d689f — every state a human can see, side by side. The reported defect was `done` reading as
  // `running`; a fixture that never shows `done` cannot prove the fix, so this one shows all nine.
  "agent-states": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      notices: [],
      agents: [
        { kind: "agent" as const, name: "producing", model: "Opus 5", status: "running" as const, attention: "working" },
        { kind: "agent" as const, name: "finished-unread", model: "Opus 5", status: "done" as const },
        { kind: "agent" as const, name: "finished-seen", model: "Opus 5", status: "idle" as const },
        { kind: "agent" as const, name: "asking", model: "Sonnet 5", status: "needs" as const, attention: "needs input" },
        { kind: "agent" as const, name: "rate-limited", model: "Sonnet 5", status: "throttled" as const },
        { kind: "agent" as const, name: "winding-down", model: "Haiku", status: "stopping" as const },
        { kind: "agent" as const, name: "wont-stop", model: "Haiku", status: "stop-failed" as const },
        { kind: "agent" as const, name: "not-running", model: "Haiku", status: "stopped" as const },
        { kind: "agent" as const, name: "died", model: "Haiku", status: "crashed" as const, sub: "exited (1)" },
      ],
    },
  },
  "attention-burst": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: SAMPLE.agents,
      notices: Array.from({ length: 24 }, (_, index) => ({
        id: `attention-burst-${index + 1}`,
        message: `Burst attention ${index + 1} — emitted straight into the list`,
        level: (["info", "warn", "error"] as const)[index % 3]!,
        at: new Date(Date.UTC(2026, 6, 27, 18, index)).toISOString(),
        collapsedCount: 1,
        actions: [],
        read: false,
        actionsLive: false,
      })),
    },
  },
  "attention-single": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: SAMPLE.agents,
      notices: [{
        id: "attention-single-1",
        message: "codex needs a decision on the release boundary",
        level: "info" as const,
        at: new Date(Date.UTC(2026, 6, 27, 18, 0)).toISOString(),
        collapsedCount: 1,
        actions: [],
        read: false,
        actionsLive: false,
      }],
    },
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
          "A seventh item now lands in the list as it is emitted",
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
