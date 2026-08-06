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

/**
 * `t-045d44` — rows shaped so the two options are VISIBLE: a model label longer than the budget, and
 * focus text longer than one line. Shared by the configured fixture and its unconfigured control so
 * the only difference between the two previews is the template itself.
 */
const OPTION_ROWS: FleetVM["agents"] = [
  {
    name: "truncated-model", status: "running", kind: "agent",
    model: "claude-opus-4-5-20251101-preview", modelSource: "observed",
    focus: {
      source: "task", taskId: "t-045d44",
      text: "per-component card template options, wrapped across the three lines this template allows so that the clamp is actually visible in the preview",
      full: "per-component card template options, wrapped across the three lines this template allows so that the clamp is actually visible in the preview",
    },
  },
  {
    name: "short-model", status: "running", kind: "agent",
    model: "gpt-5", modelSource: "declared",
    focus: { source: "brief", text: "fits on one line", full: "fits on one line" },
  },
];

export const sidebarFixtures: Record<string, Fixture<FleetVM | FleetVM[]>> = {
  // the richest canonical state — the real SAMPLE the production bundle ships.
  default: { provenance: "sample-derived", vm: SAMPLE },

  /** Two attached projects make the sidebar's project selector meaningful. SDD 485 C6 put that
   *  selector in the Control tab header; t-72ff5a moved it to the sidebar chrome and scoped the
   *  seven per-project tabs to it, so this fixture now exercises the whole sidebar, not one tab. */
  "multi-project": {
    provenance: "synthetic-edge",
    vm: [
      SAMPLE,
      { ...SAMPLE, folder: { hash: "second-project", name: "Second Project" }, agents: [] },
    ],
  },

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

  /**
   * SDD 494 Part 4 — the refusal string now opens with the disagreement state and the two owners
   * that disagree, which makes the longest line in the sidebar longer still.
   *
   * The rows are the three states that keep a roster row, because only those reach the sidebar. The
   * healthy `claude` is the neighbour the change must not regress: the refusal rides a `title`
   * tooltip, so the row's geometry must be identical to the row above it.
   */
  "disagreement-state": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "claude", model: "Opus 5", status: "idle", kind: "agent" },
        {
          name: "claude23", status: "stopped", kind: "agent",
          refused: "unprojectable — the profile and the runtime configuration disagree. profile: profile/native-config-value: Claude global key 'permissions.defaultMode' value 'bypassPermissions' is not projectable (supported: acceptEdits, auto, manual, dontAsk, plan); authorize it explicitly for this agent, set the Permissions family to Exclude, or change the global value",
        },
        {
          name: "deleted-by-hand", status: "stopped", kind: "agent",
          refused: "orphan-locator — the roster and the profile on disk disagree. profile: canonical profile is missing",
        },
        {
          name: "copied-roster", status: "stopped", kind: "agent",
          refused: "unattested — the roster and the host authority disagree. profile: host profile authority is missing",
        },
      ],
    } as FleetVM,
  },

  /**
   * t-aa2780 — the engine log-error signal at its new home, which is the only place it now has.
   *
   * Control's Engine TAB used to carry this dot; the tab strip is gone, so it lives on the sidebar's
   * Control tab icon (visible from every tab) and on the Engine tile inside it. A fixture rather than a
   * description because the thing to judge is whether a 6px mark on an existing icon still reads as an
   * alarm without looking like damage — which no test can answer and no screenshot of the default
   * fixture would ever show, since the default has no errors.
   */
  "engine-log-error": {
    provenance: "synthetic-edge",
    vm: { ...SAMPLE, engineLogHasError: true } as FleetVM,
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

  /**
   * `t-045d44` (SDD 479) — the two per-component options, each paired with a row that shows what it
   * did. `maxChars` is invisible unless a model label exceeds the budget, and `lines` is invisible
   * unless the focus text needs more than one; the second row carries content that fits, so the
   * fixture shows the DIFFERENCE rather than one styled card.
   */
  "card-template-options": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      cardTemplate: {
        base: {
          version: 1,
          header: ["status-dot", "name", "model", "model-provenance", "metrics-pill"],
          meta: ["branch", "attention", "auth-required", "verify", "harness"],
          footer: ["focus", "metrics-lanes", "actions"],
          options: { model: { maxChars: 12 }, focus: { lines: 3 } },
        },
      },
      agents: OPTION_ROWS,
    } as FleetVM,
  },

  /**
   * The control group: the SAME rows with no template at all. Without it there is nothing to compare
   * against — every row in the fixture above shares one template, so none of them shows what a
   * workspace that configured nothing gets, which is the claim the whole phase rests on.
   */
  "card-template-options-default": {
    provenance: "synthetic-edge",
    vm: { ...base, agents: OPTION_ROWS } as FleetVM,
  },
};
