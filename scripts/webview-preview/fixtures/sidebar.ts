/**
 * spec 278 — typed sidebar fixtures for the dev preview harness.
 *
 * Each fixture is a COMPLETE `FleetVM` (every required array present — a missing one crashes
 * searchIndex/countOf; that drift is intentionally fatal and now caught at BUILD because these are
 * typed against `FleetVM`, not plain JS). Each carries a `provenance` label (spec 278): the canonical
 * `default` is `sample-derived` (the real `SAMPLE`), the rest are `synthetic-edge`.
 */

import { type FleetVM, type SidebarBootVM } from "@tachyon/shared/sidebar/types";
import type { Fixture } from "../routes";

/** Representative sample fleet exercising every state/badge/section. Preview/tests only. */
export const SAMPLE: FleetVM = {
  folder: { hash: "demohash", name: "Demo" },
  handoff: { exists: true, staleness: "needs_distill", pendingCount: 3 },
  bridge: { port: "42551", connected: true },
  agents: [
    { name: "orchestrator", model: "Opus 4.8", status: "running", attention: "working", liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 12, memMb: 420 }, kind: "agent" },
    { name: "reviewer", model: "Sonnet 5", status: "running", parent: "orchestrator", harness: true, liveBranch: "main", worktreePath: "/ws", resources: { cpuPct: 8, memMb: 310 }, kind: "agent", adhoc: true },
    { name: "feature-auth", model: "GPT-5.1 Codex", status: "running", attention: "needs input", worktree: "tachyon/feature-auth", liveBranch: "tachyon/feature-auth", worktreePath: "/cache/feature-auth", resources: { cpuPct: 55, memMb: 920 }, forked: true, forkable: true, kind: "agent" },
    { name: "researcher", status: "needs", attention: "needs input", harness: true, liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "docs-writer", status: "idle", liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", liveBranch: "feat/billing-wip", branchDrift: true, worktreePath: "/cache/feature-billing", kind: "agent" },
    { name: "migration", status: "crashed", sub: "exited (1)", liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    // t-9d76b1 — a stop the HUMAN asked for, on a runtime that acknowledges SIGINT by exiting 130
    // (grok, hermes). It sits next to `migration` on purpose: these two rows are the pair a person has
    // to be able to tell apart, and while this state was absent from the sample it was absent from
    // every preview and every visual check too.
    { name: "grok-builder", status: "stopped", sub: "stopped (exit 130)", pane: true, resumable: true, liveBranch: "main", worktreePath: "/ws", kind: "agent" },
    { name: "old-spike", status: "stopped", resumable: true, liveBranch: "main", worktreePath: "/ws", kind: "agent", adhoc: true },
    { name: "qa", status: "stopped", resumable: true, worktree: "tachyon/qa", liveBranch: "tachyon/qa", worktreePath: "/cache/qa", kind: "agent" },
  ],
  terminals: [
    { name: "dev", kind: "terminal", status: "running", sub: "npm run dev" },
    { name: "shell", kind: "terminal", status: "idle", sub: "bash" },
  ],
  pipelines: [
    { name: "feature", status: "running", nodes: [
      { id: "plan", status: "running", label: "done" },
      { id: "implement", status: "running", label: "running" },
      { id: "review", status: "stopped", label: "pending" },
    ] },
    { name: "gated", status: "failed", nodes: [
      { id: "build", status: "running", label: "done" },
      { id: "deploy", status: "crashed", label: "failed", reason: "exit 1" },
    ] },
    { name: "nightly", status: "idle", nodes: [] },
  ],
  proposals: [
    { id: "pr1", name: "hourly-lint", by: "claude", when: "every 1h · run lint", reason: "lint drift on long sessions" },
  ],
  schedules: [
    { name: "nightly-audit", when: "every 1d · spawn auditor", next: "next in 6h", paused: false },
    { name: "weekly-deps", when: "every 1w · spawn deps", next: "paused", paused: true },
  ],
  pins: [
    { text: "Bridge token rotation — confirm 0.26 injection path", done: true, by: "human", tags: ["security"] },
    { text: "Investigate slow refresh on 100+ agents", done: false, by: "claude", tags: ["perf"] },
    { text: "Sidebar webview prototype — review in EDH", done: false, by: "human", tags: ["ui", "dogfood"], detail: true, attachmentCount: 2 },
  ],
  notices: [],
};

// a complete FleetVM minus `agents` — every required array present.
const base: Omit<FleetVM, "agents"> = {
  bridge: { port: "42551", connected: true },
  terminals: [],
  pipelines: [],
  proposals: [],
  schedules: [],
  pins: [],
};

/**
 * SDD 504 — a boot fixture is a fleet list plus the discovery result that explains it.
 *
 * It has to be its own shape because the states worth looking at are exactly the ones where the
 * fleet list is EMPTY, and an empty array is what the sidebar used to (wrongly) read as absence.
 * Passing `[]` alone would render the same screen for all five of them.
 */
export interface SidebarBootFixtureVM { fleets: FleetVM[]; boot: SidebarBootVM }

export type SidebarFixtureVM = FleetVM | FleetVM[] | SidebarBootFixtureVM;

export function isBootFixture(vm: SidebarFixtureVM): vm is SidebarBootFixtureVM {
  return !Array.isArray(vm) && "boot" in vm;
}

/** Long enough to wrap at 360px — the width where a folder name stops fitting on one line. */
const LONG_FOLDER = "tachyon-monorepo-feature-truthful-sidebar-boot";

export const sidebarFixtures: Record<string, Fixture<SidebarFixtureVM>> = {
  // SDD 504 — the five screens the boot contract owes a reader. `boot-*` fixtures carry no fleet on
  // purpose; the sixth state (ready) is every other fixture in this file.
  "boot-unknown": {
    provenance: "synthetic-edge",
    vm: { fleets: [], boot: { discovered: false, folders: [] } },
  },
  "boot-starting": {
    provenance: "synthetic-edge",
    vm: {
      fleets: [],
      boot: { discovered: true, folders: [{ hash: "h-1", name: LONG_FOLDER, phase: "starting", startedAt: Date.now() }] },
    },
  },
  "boot-delayed": {
    provenance: "synthetic-edge",
    vm: {
      fleets: [],
      // Stamped well past the threshold so the fixture renders the delayed copy deterministically.
      boot: { discovered: true, folders: [{ hash: "h-1", name: LONG_FOLDER, phase: "starting", startedAt: Date.now() - 60_000 }] },
    },
  },
  "boot-failed": {
    provenance: "synthetic-edge",
    vm: {
      fleets: [],
      boot: {
        discovered: true,
        folders: [{
          hash: "h-1",
          name: LONG_FOLDER,
          phase: "failed",
          // A real engine refusal is this long and has no spaces to break on — the case that decides
          // whether the notice wraps or pushes the sidebar sideways.
          detail: "persistent engine control socket already has a live owner (/run/user/1000/tachyon/engines/b349073a/control.sock)",
        }],
      },
    },
  },
  "boot-unconfigured": {
    provenance: "synthetic-edge",
    vm: { fleets: [], boot: { discovered: true, folders: [{ hash: "h-1", name: "some-folder", phase: "unconfigured" }] } },
  },
  /** Multi-root: one project ready, one still starting, one failed — the strip above live lists. */
  "boot-multi-root": {
    provenance: "synthetic-edge",
    vm: {
      fleets: [SAMPLE],
      boot: {
        discovered: true,
        folders: [
          { hash: SAMPLE.folder?.hash ?? "h-ready", name: SAMPLE.folder?.name ?? "Ready", phase: "ready" },
          { hash: "h-slow", name: LONG_FOLDER, phase: "starting", startedAt: Date.now() },
          { hash: "h-bad", name: "other-project", phase: "failed", detail: "engine refused the attach" },
        ],
      },
    },
  },

  // the richest canonical state — the preview SAMPLE (not shipped in the production sidebar).
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
        { name: "feature-auth", status: "running", worktree: "tachyon/feature-auth", kind: "agent",
          evidence: { total: 3, stale: 0, warn: 1, error: 0 } },
        { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", kind: "agent",
          evidence: { total: 2, stale: 2, warn: 0, error: 0 } },
        { name: "migration", status: "running", worktree: "tachyon/migration", kind: "agent",
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
    vm: { ...base, agents: [{ name: "migration", status: "crashed", sub: "exited (1)", kind: "agent" }] } as FleetVM,
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
        { name: "gated-reviewer", model: "GPT-5.1 Codex", status: "running", delegator: "codex", worktree: "tachyon/gated-reviewer", kind: "agent" },
        { name: "orphan-owned", status: "stopped", declaredOwner: "missing-owner", kind: "agent" },
      ],
    } as FleetVM,
  },

  /**
   * t-1464cf — visual pair for the `≠ declared` calculation.
   *
   * Anchor (from the card, before the capture): agents without an explicit `--model` must not wear
   * `≠ declared` even when the observed label differs from the profile default. A real mismatch —
   * spawn pinned `--model X`, transcript shows Y — still must.
   */
  "model-divergence": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "claude", model: "Sonnet 5", modelSource: "observed", status: "running", kind: "agent" as const },
        { name: "hunkgrok", model: "Grok 4.6", modelSource: "observed", status: "idle", kind: "agent" as const },
        { name: "lembretecodex", model: "GPT-5.6 Sol", modelSource: "observed", status: "running", kind: "agent" as const },
        { name: "cb684f-no-plan", model: "GPT-5.6 Sol", modelSource: "observed", status: "idle", kind: "agent" as const },
        { name: "cb684f-with-plan", model: "GPT-5.6 Sol", modelSource: "observed", status: "running", kind: "agent" as const },
        { name: "pinned-wrong", model: "Haiku 4.5", modelSource: "observed", modelDivergence: true, status: "running", kind: "agent" as const },
      ],
    },
  },

  // t-fde5b6 — the scroll proof: far more attention than the panel's max-height can show. The panel
  // must stay the same height and scroll internally, never grow or push the rest of the sidebar.
  // Every state a human can see, side by side.
  "agent-states": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      notices: [],
      agents: [
        { kind: "agent" as const, name: "producing", model: "Opus 5", status: "running" as const, attention: "working" },
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
  /**
   * `t-2656d7` (SDD 495 first slice) — the notice that replaces the status-bar flash.
   *
   * The anchor, written from the problem statement before the slice was built: *a human who pressed
   * ▶ on an unauthenticated agent can read, without hovering, scrolling or waiting, which runtime is
   * unauthenticated, which agent it blocked, and what to press next — and the thing to press is
   * visible as a control, not as the tail of a sentence.*
   *
   * That is why this fixture carries the real message verbatim rather than a short placeholder: the
   * sentence is LONG, and its length is what the incident was made of. The row has to stay readable
   * with the buttons still reachable at 360 as well as 880. The second row is the runtime with no
   * measured login command — it must lose the button and keep everything else.
   *
   * The neighbour to not regress is the `auth-required` fixture above: the mid-run hold renders
   * through this same notice path and must look unchanged beside it.
   */
  "login-refused": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        { name: "grok-builder", model: "grok-4", status: "idle", kind: "agent" as const },
        { name: "pi-scout", model: "pi", status: "idle", kind: "agent" as const },
      ],
      notices: [
        {
          id: "login-refused-1",
          message: "agent 'grok-builder' cannot run: the grok runtime reports it is not authenticated"
            + " — run `grok login --device-code`, or set XAI_API_KEY, then restart the agent explicitly."
            + " Tachyon will not retry or restart it automatically.",
          level: "warn" as const,
          at: new Date(Date.UTC(2026, 7, 7, 22, 41)).toISOString(),
          collapsedCount: 1,
          actions: [
            { id: "login-refused-1-login", label: "Log in" },
            { id: "login-refused-1-retry", label: "Retry" },
          ],
          read: false,
          actionsLive: true,
        },
        {
          id: "login-refused-2",
          message: "agent 'pi-scout' cannot run: the pi runtime reports it is not authenticated"
            + " — run /login in Pi, or set the provider API-key environment variable, then restart the agent explicitly."
            + " Tachyon will not retry or restart it automatically.",
          level: "warn" as const,
          at: new Date(Date.UTC(2026, 7, 7, 22, 42)).toISOString(),
          collapsedCount: 1,
          actions: [{ id: "login-refused-2-retry", label: "Retry" }],
          read: false,
          actionsLive: true,
        },
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
   * t-195a6c — the two imprecise glances on the same screen: a triaged card
   * must read as parked (the word, not only the id), an active card must
   * still read as in-progress, a live agent without a card still says
   * "no board task", and a dead resumable card must not claim leftover
   * brief as current work.
   */
  "board-assignment-state": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        {
          name: "claude", model: "Opus 4.8", status: "idle", kind: "agent", attention: "idle",
          focus: {
            source: "task", taskId: "t-b928fc", taskStatus: "triaged",
            text: "Registrar o processo",
            full: "t-b928fc  Registrar o processo",
          },
        },
        {
          name: "cartagrok", model: "grok-4", status: "running", kind: "agent", attention: "working",
          focus: {
            source: "task", taskId: "t-195a6c", taskStatus: "active",
            text: "sidebar card precision",
            full: "t-195a6c  sidebar card precision",
          },
        },
        {
          name: "idle-temp", model: "grok-4", status: "idle", kind: "agent", attention: "idle",
          focus: { source: "brief", text: "waiting for the next card", full: "waiting for the next card" },
        },
        {
          name: "syspromptcodex", model: "GPT-5.1 Codex", status: "stopped", kind: "agent",
          resumable: true,
          focus: {
            source: "brief",
            text: "FATIA 1, e ela e so MEDIC",
            full: "FATIA 1, e ela e so MEDIC — delivered hours ago",
          },
        },
      ],
    } as FleetVM,
  },

  /**
   * t-281339 — ANCHOR (written before the line existed): four agents, one
   * glance, no panel. An in-progress step is the line; with no in-progress
   * the next pending is shown; all-completed and no-channel occupy no line;
   * absent is a discrete --ds-warn mark. Long step text is one line with
   * ellipsis. Measured at 880 and 360.
   */
  "internal-checklist-line": {
    provenance: "synthetic-edge",
    vm: {
      ...base,
      agents: [
        {
          name: "claude", model: "Opus 4.8", modelSource: "declared", status: "running", kind: "agent", runtime: "claude",
          focus: { source: "task", taskId: "t-281339", taskStatus: "active", text: "sidebar plan line", full: "sidebar plan line" },
          checklist: { kind: "step", text: "write the current checklist step on the sidebar card without growing the row", position: 12, total: 15 },
        },
        {
          name: "grok", model: "grok-4", modelSource: "declared", status: "running", kind: "agent", runtime: "grok",
          focus: { source: "task", taskId: "t-904de5", taskStatus: "active", text: "grok reader", full: "grok reader" },
          checklist: { kind: "step", text: "Steep the tea", position: 2, total: 3 },
        },
        {
          name: "cartagrok", model: "grok-4", modelSource: "declared", status: "idle", kind: "agent", runtime: "grok",
          focus: { source: "task", taskId: "t-011136", taskStatus: "active", text: "turn verdict", full: "turn verdict" },
          checklist: { kind: "absent" },
        },
        {
          name: "syspromptcodex", model: "GPT-5.1 Codex", modelSource: "declared", status: "running", kind: "agent", runtime: "codex",
          focus: { source: "task", taskId: "t-1ee107", taskStatus: "active", text: "codex reader", full: "codex reader" },
        },
      ],
    } as FleetVM,
  },

  /**
   * t-7d6013 — the durable record of what `tachyon.yml` DISCARDED, on an otherwise healthy fleet.
   *
   * The control is `default` (the same SAMPLE with no banner), so the only difference between the two
   * captures is the surface itself. Every row here is a VERBATIM parser message — produced by running
   * `parseConfig` over a file carrying those five mistakes, not written to look plausible — and the
   * first one is the expensive case the owner's rule leaves standing: the key name is misspelled, so
   * the whole entry is dropped and a delegated codex agent falls back to `danger-full-access`.
   */
  /**
   * SDD 512 fatia 2 — short info notice under a live roster. The collapsed footer must stay one
   * operator row so a short list is not shorter than the status it replaced.
   */
  "status-notice": {
    provenance: "synthetic-edge",
    vm: {
      ...SAMPLE,
      statusNotice: {
        message: "Nothing to review",
        level: "info",
        at: "2026-08-17T12:00:00.000Z",
      },
    } as FleetVM,
  },

  /**
   * SDD 512 fatia 2 — measured max (161 chars) at error, with the agent list still on screen.
   * The footer must keep a path to the rest; ellipsis-only is the original defect.
   */
  "status-notice-long": {
    provenance: "synthetic-edge",
    vm: {
      ...SAMPLE,
      statusNotice: {
        message: "an action-less notice is precisely the branch that routes to setStatusBarMessage — clipped by width, erased on a timer, no button. That is where the owner's run grok login first went.",
        level: "error",
        at: "2026-08-17T12:00:00.000Z",
      },
    } as FleetVM,
  },

  "config-discards": {
    provenance: "synthetic-edge",
    vm: {
      ...SAMPLE,
      configDiscards: {
        file: "tachyon.yml",
        path: "/home/dev/project/tachyon.yml",
        entries: [
          "settings.agentPermissionProjection.reviewer: unknown key 'sandbox_mode'",
          "settings.agentPermissionProjection.reviewer: a codex entry must set at least one of approvalPolicy, sandboxMode, bridgeToolApproval",
          "settings.worktree.shareDependencies: must be a boolean",
          "settings.companion: unknown key 'allowedHost'",
          "settings.maxAgents: must be an integer >= 1",
        ],
        summary: "settings.agentPermissionProjection.reviewer: unknown key 'sandbox_mode' (+4 more)",
        signature: "0123456789abcdef",
      },
    } as FleetVM,
  },
};
