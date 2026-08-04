import { runtimeOf, type ResumeRuntime } from "../resume/adapters.js";

export type RuntimeProfileSource = "measured" | "declared" | "assumed";
export type IsolationMechanism = "mint" | "private-home" | "project-scoped" | "unknown" | "none";

export interface RuntimeProfileSection {
  source: RuntimeProfileSource;
  verified: boolean;
  verifiedAt?: string;
  notes?: string;
}

export interface IsolationProfile extends RuntimeProfileSection {
  mechanism: IsolationMechanism;
}

export interface TranscriptIsolationContext {
  /** True when the spawn is known to run in an isolated git worktree. */
  isolatedWorktree?: boolean;
  /** True when the runtime lineage parent is present on this spawn. */
  parented?: boolean;
}

/**
 * t-30ff0d — a MEASURED, content-only proof that work is still in flight while the pane sits still.
 *
 * `AttentionMonitor` decides idle from two things: the pane stopped changing, and CPU is quiet.
 * Both are true of an agent that has handed work to a background shell, an MCP server or a monitor
 * and is waiting on it — the pane freezes and the process blocks on I/O rather than burning CPU. The
 * sidebar then says idle while the agent is demonstrably mid-flight, which is the reproduction this
 * exists to close.
 *
 * Deliberately NOT the other two candidates: CPU utilization is what `t-285503` flapped on, and
 * process existence says nothing about whether the agent is doing anything. This asks the pane, and
 * only inside `tailLines` from the bottom — the same history that proves work is running scrolls up
 * and stays quotable forever, so a whole-pane match would pin an agent to "working" for the rest of
 * its life.
 */
export interface ActivitySignalProfile extends RuntimeProfileSection {
  /** How far from the pane bottom the signal is expected. Keeps stale transcript history out. */
  tailLines: number;
  /** Line shape that means the runtime still owes this turn work it has not finished. */
  runningLine: RegExp;
  /**
   * Optional, newer proof that the runtime already handed the turn back. Some runtimes leave a
   * background monitor in their mode line after the work it watched has finished; that residual
   * process must not outweigh an explicit handback at the stable composer.
   */
  settledLine?: RegExp;
  /** Tail bound for `settledLine`; defaults to `tailLines`. */
  settledTailLines?: number;
}

export interface ComposerRegionProfile extends RuntimeProfileSection {
  /** How far from the pane bottom Tachyon should look for the runtime input composer. */
  tailLines: number;
  /** Prompt-glyph runtimes: line that begins the editable region. Exactly one of promptLine/frameLine is expected. */
  promptLine?: RegExp;
  /** Framed runtimes: the final two matching lines bound the editable region (exclusive). */
  frameLine?: RegExp;
  /** Optional footer/status proof used by launch readiness in addition to a framed editor. */
  readyLine?: RegExp;
  /** Runtime-specific line shape inside the editable region that means the human has a draft. */
  occupiedLine: RegExp;
  /**
   * Runtime-specific ANSI style that marks a prompt-glyph line as an ALREADY-SUBMITTED message the
   * runtime echoed back into its transcript. Such a line matches `promptLine`, but it is HISTORY
   * rather than the editable region, and history can never be a human draft.
   *
   * `"prompt-background"`: the glyph is painted with an SGR background colour. `t-6ffa13` measured
   * Claude Code 2.1.220 — a submitted message renders as `\x1b[38;5;239m\x1b[48;5;237m❯ …` while the
   * live composer carries no background in any state (empty, suggestion, typed draft).
   *
   * Declare this ONLY from a measured rendering difference, never from what the text says, and note
   * the direction of danger: a wrong declaration is PERMISSIVE, because a line dismissed as history
   * stops protecting the draft it might really be. With no escaped capture there is no background to
   * read, so the detector keeps treating the line as the composer and still refuses.
   */
  ansiHistoryEchoStyle?: "prompt-background";
  /**
   * Runtime-specific ANSI style rule that can make otherwise non-empty prompt content count as empty.
   *
   * Declare this ONLY for a runtime measured to render suggestion text inside an otherwise empty
   * composer (claude `t-c5f29b`, codex `t-aee74e`). It is what lets content NOT count as a human
   * draft, so declaring it speculatively weakens the protection against injecting over typed text.
   * `t-3eaa8b` measured grok/opencode/pi/hermes across empty, typed-draft and post-turn states and
   * found no such suggestion in any of them — hence no declaration for those four.
   */
  ansiEmptyContentStyle?: "all-dim";
}

export interface RuntimeModelProfile extends RuntimeProfileSection {
  /** Human-readable fallback when the command does not pin a model flag. */
  defaultModel: string;
  /** Known runtime-specific ids/shorthands normalized for the sidebar. Keys are matched case-insensitively. */
  aliases?: Record<string, string>;
}

export interface RuntimePermissionProfile extends RuntimeProfileSection {
  modes: string[];
  alwaysApproveFlag?: string;
}

export type GracefulStopStep =
  | { type: "interruptActiveTurn" }
  | { type: "sendKey"; key: string }
  | { type: "sendKeyIfAliveAfterDelay"; key: string; delayMs: number }
  | { type: "sendTextIfAliveAfterDelay"; text: string; delayMs: number };

export interface GracefulStopProfile extends RuntimeProfileSection {
  steps: GracefulStopStep[];
}

export interface RuntimeProfile {
  runtime: ResumeRuntime;
  profileVersion: number;
  label?: string;
  model?: RuntimeModelProfile;
  isolation: IsolationProfile;
  permission?: RuntimePermissionProfile;
  composer?: ComposerRegionProfile;
  /** t-30ff0d — content proof of in-flight work when the pane is static. */
  activity?: ActivitySignalProfile;
  gracefulStop?: GracefulStopProfile;
  /** Honest canonical-runtime constraints surfaced before lifecycle actions. */
  canonicalLimitations?: CanonicalRuntimeLimitation[];
}

export const CANONICAL_RUNTIME_LIMITATIONS = [
  "permission-policy-partial",
  "attention-composer-unverified",
  "stop-active-turn-unverified",
  "oauth-concurrency-single-live",
] as const;

export type CanonicalRuntimeLimitation = (typeof CANONICAL_RUNTIME_LIMITATIONS)[number];

export const DEFAULT_GRACEFUL_STOP: GracefulStopProfile = {
  steps: [
    { type: "sendKey", key: "C-c" },
    { type: "sendKey", key: "C-c" },
    { type: "sendKey", key: "C-d" },
  ],
  source: "assumed",
  verified: false,
  notes: "Fallback for unknown runtimes: try a double interrupt before EOF so CLIs that ignore bare Ctrl-D still get a common exit path.",
};

/**
 * t-b103c5 (2026-07-29) — Grok's native tool-authorization chrome binds Ctrl+C to **cancel**, not
 * exit (`1/3:select │ Ctrl+o:always-approve │ Ctrl+c:cancel`, fixture in
 * `test/unit/grokAuthorizationPrompt.test.ts`). Back-to-back C-c C-c both land as cancel while the
 * prompt is up, so the process stays alive and the UI flips to opaque "stop failed" after
 * STOPPING_FALLBACK_MS. Delays let cancel leave the prompt before the exit pair is sent; a third
 * if-alive C-c completes the exit pair when the first press only cancelled. Measured idle (0.2.114):
 * single C-c stays alive; delayed C-c C-c exits; `/exit` does not exit.
 */
const GROK_GRACEFUL_STOP: GracefulStopProfile = {
  steps: [
    { type: "sendKey", key: "C-c" },
    { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
    { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
  ],
  source: "measured",
  verified: true,
  verifiedAt: "2026-07-29",
  notes:
    "t-bae032: idle exits on Ctrl-C then Ctrl-C (bare Ctrl-D and single Ctrl-C stay alive). "
    + "t-b103c5: tool-auth prompt remaps Ctrl+C to cancel — delay between presses and a third "
    + "if-alive Ctrl+C so cancel-then-exit still works; do not auto-force on user Stop (Kill forced is explicit).",
};

export const RUNTIME_PROFILES: Partial<Record<ResumeRuntime, RuntimeProfile>> = {
  pi: {
    runtime: "pi",
    profileVersion: 3,
    label: "Pi",
    isolation: {
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-18",
      notes: "SDD 401: Tachyon redirects PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR to a per-agent private home.",
    },
    composer: {
      tailLines: 16,
      frameLine: /^─{10,}\s*$/,
      readyLine: /^\s*\d+(?:\.\d+)?%\/\S+.*\S+\s*$/,
      occupiedLine: /\S/,
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-18",
      notes: "SDD 403: Pi v0.80.10 renders its editor between the final two horizontal rules; non-whitespace inside is a human draft.",
    },
    gracefulStop: {
      steps: [
        { type: "sendKey", key: "Escape" },
        { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
        { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
        { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
      ],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-18",
      notes: "SDD 403 / Pi defaults: Escape aborts, Ctrl+C clears residual editor state, Ctrl+D exits when empty; verified idle and drafted in isolated tmux.",
    },
    permission: {
      modes: ["full", "reviewer-read-only"],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-18",
      notes: "SDD 404: Delivery reviewers inject --exclude-tools bash,edit,write. This is shell-level tool safety, not an OS sandbox or universal Bridge read-only guarantee.",
    },
    canonicalLimitations: ["oauth-concurrency-single-live"],
  },
  claude: {
    runtime: "claude",
    profileVersion: 2,
    model: {
      defaultModel: "Claude default",
      aliases: {
        opus: "Opus",
        "opus-4.8": "Opus 4.8",
        "claude-opus-4-8": "Opus 4.8",
        sonnet: "Sonnet",
        "sonnet-5": "Sonnet 5",
        "claude-sonnet-5": "Sonnet 5",
        haiku: "Haiku",
      },
      source: "declared",
      verified: false,
      notes: "t-140242 v1: command --model wins; bare claude falls back to the runtime-profile default label until dynamic runtime introspection lands.",
    },
    isolation: {
      mechanism: "mint",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-05",
      notes: "Spec 220: Tachyon spawns Claude with a per-agent name and captures the resulting uuid/customTitle.",
    },
    permission: {
      modes: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-26",
      notes:
        "Claude Code 2.1.220 accepted every declared --permission-mode value and rejected an invalid value. " +
        "Canonical profiles regenerate validated global/workspace permissions in their private settings.json on fresh/restart/resume/fork; " +
        "the typed policy rejects bypassPermissions and invalid values instead of synthesizing a fallback (t-fdd3a0 / SDD 465).",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      // t-6ffa13 — a submitted message echoed into the transcript paints its glyph with a background
      // (measured: \x1b[38;5;239m\x1b[48;5;237m❯ ). The live composer never carries one, in any state.
      ansiHistoryEchoStyle: "prompt-background",
      ansiEmptyContentStyle: "all-dim",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-27",
      notes:
        "t-3fe20f: live Claude Code CLI renders its composer prompt as U+276F '❯' (measured on tachyon-b349073a-claude, " +
        "raw bytes e2 9d af), not ASCII '>'; the unmeasured t-f30324 regex never matched, permanently wedging isReady() " +
        "for every claude-runtime agent once LAUNCH_READINESS_RUNTIMES started gating claude (t-9d2299). " +
        "t-c5f29b: Claude Code 2.1.220 renders a SUGGESTION inside an otherwise empty composer, and Tachyon read it as a " +
        "human draft and refused continuity. Measured on a live pane: the suggestion is entirely SGR-dim " +
        "(\\x1b[39m❯\\u00a0\\x1b[2mTry \"fix typecheck errors\"\\x1b[0m) while a typed draft carries no dim at all " +
        "(\\x1b[39m❯\\u00a0integre em main e verifique o tree — the incident's own text, typed). Same rule Codex already " +
        "uses. The separator after '❯' is U+00A0 in BOTH cases, so it discriminates nothing; the dim styling is the only " +
        "signal, and without an escaped capture the detector stays conservative and still refuses.",
    },
    activity: {
      tailLines: 3,
      // Measured on Claude Code 2.1.220 (2026-07-28, t-30ff0d) with a real background shell in
      // flight. The mode line is the bottom-most non-empty line and gains a shell counter while work
      // is outstanding: `⏵⏵ accept edits on · 1 shell · ← for agents`; once the work finishes it
      // reverts to `⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`.
      //
      // The transcript ALSO says `✻ Sautéed for 5s · 1 shell still running`, and that line is the
      // tempting one — but it freezes at its last elapsed value and scrolls up, so it is present in
      // the after-final pane too. Matching it without a bottom bound would hold an agent at
      // "working" forever. Fixtures for both states: test/fixtures/claude-activity/.
      runningLine: /·\s*\d+\s+shells?\s*·/,
      // t-ca4a3c — measured on the claude-reviewer incident. Claude had completed its response,
      // emitted the recap handback and returned to a stable composer, while a harness monitor was
      // still counted as `1 shell` in the mode line. The recap is newer evidence about the turn
      // than that residual process counter. A genuinely outstanding background shell has no recap
      // (the t-30ff0d fixture remains the positive control).
      settledLine: /※\s*recap:/,
      settledTailLines: 12,
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-29",
      notes:
        "t-30ff0d: a background shell leaves the pane byte-identical for seconds while the process"
        + " blocks on I/O, so both of AttentionMonitor's idle inputs (no content change, quiet CPU)"
        + " read as idle while the agent is demonstrably mid-flight. This is the pane's own statement"
        + " that it still owes the turn work. NOT measured: an MCP/tool call with no shell — the"
        + " reproduction that prompted this was a background shell, and the streaming spinner ticks"
        + " (so content change already covers it). t-ca4a3c: an explicit Claude recap at the stable"
        + " composer wins over a residual shell/monitor counter; without that precedence an idle"
        + " claude-reviewer was reported working indefinitely.",
    },
    gracefulStop: {
      steps: [
        { type: "interruptActiveTurn" },
        { type: "sendKey", key: "C-c" },
        { type: "sendTextIfAliveAfterDelay", text: "/exit", delayMs: 150 },
      ],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-25",
      notes:
        "Claude Code 2.1.220: Ctrl+C clears an unsubmitted draft but Ctrl+D does not exit it; a local /exit command then cleanly exits. " +
        "An authorized real model turn was stopped with Escape, Ctrl+C, then conditional /exit; the pane exited with status 0. Keep interrupt, clear-composer, then conditional /exit.",
    },
    canonicalLimitations: [],
  },
  codex: {
    runtime: "codex",
    profileVersion: 2,
    model: {
      defaultModel: "Codex default",
      aliases: {
        "gpt-5.1-codex": "GPT-5.1 Codex",
        "gpt-5-codex": "GPT-5 Codex",
        "gpt-5.6-sol": "GPT-5.6 Sol",
        "gpt-5.6-terra": "GPT-5.6 Terra",
        "gpt-5.6-luna": "GPT-5.6 Luna",
      },
      source: "declared",
      verified: false,
      notes:
        "t-140242 v1: command --model wins; bare codex falls back to this profile label until config/session introspection lands. " +
        "t-140a24: sidebar also reads Codex `-c model=<id>` overrides (fleet form); Sol/Terra/Luna aliases polish gpt-5.6-* labels.",
    },
    isolation: {
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-05",
      notes: "Spec 357: Tachyon-spawned Codex agents use per-agent private CODEX_HOME directories.",
    },
    permission: {
      modes: [
        "approval_policy:untrusted",
        "approval_policy:on-failure",
        "approval_policy:on-request",
        "approval_policy:never",
        "sandbox_mode:read-only",
        "sandbox_mode:workspace-write",
        "sandbox_mode:danger-full-access",
        // t-aaa2c6 — the third door, per MCP server, measured separately from approval_policy.
        "mcp_tool_approval:auto",
        "mcp_tool_approval:prompt",
        "mcp_tool_approval:writes",
        "mcp_tool_approval:approve",
      ],
      source: "measured",
      verified: true,
      verifiedAt: "2026-08-02",
      notes:
        "Canonical profiles regenerate the selected approval_policy and sandbox_mode in private CODEX_HOME/config.toml on fresh/restart/resume " +
        "(t-1a3d50). Codex CLI 0.145.0 accepted every declared key/value under --strict-config. This does not apply a policy to legacy arbitrary commands. " +
        "t-aaa2c6 measured codex-cli 0.146.0 and found THREE independent approval doors, not one: approval_policy is COMMAND approval; sandbox_mode is the " +
        "WRITE door (under workspace-write, `git add` in a Tachyon worktree fails on <repo>/.git/worktrees/<agent>/index.lock, because the worktree's git " +
        "directory sits outside its own cwd); and mcp_servers.<server>.default_tools_approval_mode (auto|prompt|writes|approve) is MCP TOOL approval, which " +
        "approval_policy at its default does NOT cover — a read-only Bridge-shaped tool still stopped at 'Allow the <server> MCP server to run tool …?' until " +
        "that per-server key was set to approve. t-aaa2c6 projects all three by CLASS for a delegated child only; top-level absence preserves Codex's defaults, " +
        "an authored profile's own approval_policy/sandbox_mode is never widened, and no value is inherited from the environment. " +
        "t-171cb2 closes the fourth measured door — the startup directory-trust prompt — on the same class boundary: exact-path " +
        "`projects.\"<path>\".trust_level` (measured: NOT prefix-inherited, NOT governable via argv `-c`) is written into the private " +
        "CODEX_HOME/config.toml for a delegated child only, for workspace root + the exact spawn cwd (the new worktree path known at " +
        "materialize time). Ambient projects tables from the human's `~/.codex` are stripped on that path so trust does not leak; " +
        "top-level and declared keep today's seed-only home. Canonical Codex homes already wrote the same blocks (materializeCanonicalCodexProfileHome). " +
        "Third-party MCP servers keep Codex's default posture because Tachyon does not vouch for them. " +
        "Measured on the same build: `--full-auto` is REJECTED (\"unexpected argument\"), while `--yolo` still parses although --help documents neither; " +
        "the documented one-token form is --dangerously-bypass-approvals-and-sandbox. What --yolo grants was not measured and is not relied on here.",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      ansiEmptyContentStyle: "all-dim",
      source: "declared",
      verified: false,
      notes:
        "t-f30324: Codex's human input composer is a bottom-of-pane prompt line beginning with '❯'/'>'/'›'. " +
        "t-aee74e: placeholder text after the prompt is entirely SGR-dim and does not count as a human draft.",
    },
    gracefulStop: {
      steps: [
        { type: "interruptActiveTurn" },
        { type: "sendKey", key: "C-c" },
        { type: "sendKey", key: "C-d" },
        { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
      ],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-13",
      notes:
        "t-82456f: Codex 0.144.1 resumed sessions can retain composer/startup state that consumes a bare EOF; " +
        "interrupt the active turn, clear residual input, then retry EOF if the pane is still alive.",
    },
  },
  opencode: {
    runtime: "opencode",
    profileVersion: 1,
    isolation: {
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
      notes:
        "t-e2ebe3: opencode is XDG-compliant (measured 2026-07-08, opencode 1.17.15). Tachyon spawns an " +
        "opencode harness agent with per-agent XDG_CONFIG/DATA/STATE_HOME redirection (independent of cwd, " +
        "like claude/codex) so an OPencode agent gets its own config/auth/state namespace — and can be delegated " +
        "UNGATED (no isolated worktree required, unlike the prior project-scoped rating in t-6a5dae).",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      source: "assumed",
      verified: false,
      notes: "t-f45313: conservative composer guard for pane-injection safety; exact prompt shape still needs runtime measurement.",
    },
    gracefulStop: {
      steps: [{ type: "sendKey", key: "C-d" }],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
      notes: "t-bae032 journal: opencode 1.17.15 exits on bare Ctrl-D, so keep the existing EOF path working.",
    },
  },
  grok: {
    runtime: "grok",
    profileVersion: 1,
    label: "Grok",
    model: {
      defaultModel: "Grok default",
      source: "declared",
      verified: false,
      notes: "t-14649d: grok --help declares -m/--model; bare grok falls back to this profile label until config/session introspection lands.",
    },
    isolation: {
      mechanism: "project-scoped",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
      notes:
        "Grok has native -w/--worktree support. Canonical profiles additionally regenerate a private GROK_HOME and HOME, but legacy/Temporary Grok commands remain project-scoped, so runtime-wide transcript isolation is not yet declared.",
    },
    permission: {
      modes: ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"],
      alwaysApproveFlag: "--always-approve",
      source: "measured",
      verified: false,
      verifiedAt: "2026-07-25",
      notes: "Grok 0.2.112 accepts every listed --permission-mode value and rejects invalid input. Canonical HOME isolation excludes ambient Claude settings. t-84f0eb adds an opt-in per-agent workspace authority and projects the owner's authored --always-approve default only for delegated subagents; top-level absence preserves Grok's default and no value is inherited from the environment.",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-28",
      notes:
        "t-aafa10 measured grok 0.2.112 in a real tmux pane: the composer is a bottom-pinned box rendering"
        + " `│ ❯ `, so the t-f45313 guess turned out to be right and is now pinned by byte fixtures"
        + " (test/unit/grokComposerMeasured.test.ts). Empty, human draft, post-turn and draft-after-turn all"
        + " classify correctly, and the composer is empty after a turn — no suggestion text, which is why"
        + " ansiEmptyContentStyle stays undeclared. Grok DOES echo the submitted prompt into its transcript"
        + " with the same glyph, but the box is pinned to the bottom and findComposerRegion scans upward, so"
        + " the echo can never win. NOT measured: the mid-turn render, which needs a live model call —"
        + " attention-composer-unverified is retained for exactly that gap.",
    },
    gracefulStop: GROK_GRACEFUL_STOP,
    canonicalLimitations: ["permission-policy-partial", "attention-composer-unverified"],
  },
  hermes: {
    runtime: "hermes",
    profileVersion: 1,
    label: "Hermes Agent",
    model: {
      defaultModel: "Hermes default",
      source: "declared",
      verified: false,
      notes: "Model comes from ~/.hermes/config.yaml (or private HERMES_HOME); no stable CLI default to pin here yet.",
    },
    isolation: {
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-13",
      notes:
        "HERMES_HOME redirects the full home (config.yaml, auth.json, state.db). Tachyon materializes " +
        "a private home for Bridge (bridge-mcp/<agent>.hermes) and harness/isolate paths.",
    },
    permission: {
      modes: ["default", "yolo"],
      alwaysApproveFlag: "--yolo",
      source: "declared",
      verified: false,
      notes: "CLI --yolo bypasses dangerous-command approvals; spawn inject is a follow-up (readers required).",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      source: "assumed",
      verified: false,
      notes: "Conservative peer-shaped composer guard; Hermes TUI prompt not measured yet.",
    },
    gracefulStop: {
      steps: [
        { type: "sendKey", key: "C-c" },
        { type: "sendKey", key: "C-c" },
      ],
      source: "declared",
      verified: false,
      notes: "Hermes docs: Ctrl+C interrupt; double within 2s force-exits. Unmeasured in Tachyon pane.",
    },
  },
};

export function runtimeProfile(runtime: ResumeRuntime): RuntimeProfile | undefined {
  return RUNTIME_PROFILES[runtime];
}

export function gracefulStopForCommand(cmd: string): GracefulStopProfile {
  const runtime = runtimeOf(cmd);
  if (runtime) return runtimeProfile(runtime)?.gracefulStop ?? DEFAULT_GRACEFUL_STOP;
  return DEFAULT_GRACEFUL_STOP;
}

function titleModelId(modelId: string): string {
  return modelId
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])([a-z0-9.]*)/gi, (_m, first: string, rest: string) => first.toUpperCase() + rest);
}

export function modelLabelForRuntime(runtime: ResumeRuntime, modelId?: string): string | undefined {
  const model = runtimeProfile(runtime)?.model;
  const trimmed = modelId?.trim();
  if (!trimmed) return model?.defaultModel;
  return model?.aliases?.[trimmed.toLowerCase()] ?? titleModelId(trimmed);
}

export function isolationMechanismForCommand(cmd: string): IsolationProfile {
  const runtime = runtimeOf(cmd);
  const profile = runtime ? runtimeProfile(runtime) : undefined;
  return profile?.isolation ?? {
    mechanism: runtime ? "unknown" : "none",
    source: "assumed",
    verified: false,
    notes: runtime ? `runtime '${runtime}' has no active runtime profile` : "command does not resolve to a known AI runtime",
  };
}

export function hasVerifiedTranscriptIsolation(isolation: IsolationProfile, context: TranscriptIsolationContext = {}): boolean {
  if (!isolation.verified) return false;
  if (isolation.mechanism === "mint" || isolation.mechanism === "private-home") return true;
  return isolation.mechanism === "project-scoped" && context.isolatedWorktree === true;
}

/**
 * RULING (t-ef19a1): a tachyon.yml-declared agent's author already has full extension trust — a
 * different tier than a Temporary delegated spawn — so a declared opencode agent with no `harness:`
 * block is INTENTIONALLY allowed to run without isolation. It is, however, a footgun: without
 * `harness: {}` (or an isolated worktree) it shares the global `~/.local/share` opencode
 * config/auth/session state with every other non-isolated opencode agent. This never changes the
 * allow/refuse decision — it only produces the one-line warning text to surface at spawn time.
 */
export function opencodeIsolationFootgunWarning(
  cmd: string,
  context: { name: string; harness?: boolean; isolatedWorktree?: boolean },
): string | undefined {
  if (runtimeOf(cmd) !== "opencode") return undefined;
  if (context.harness || context.isolatedWorktree) return undefined;
  return (
    `opencode agent '${context.name}' runs without isolation — it shares the global ~/.local/share ` +
    "config/auth/sessions with other opencode agents; add `harness: {}` to isolate it"
  );
}

/**
 * t-110aaa — verified project-scoped state is a disclosed capability trade-off, not a delegation
 * boundary. The warning belongs to the only affected door: a parented, non-harness spawn sharing
 * its checkout. Top-level, harnessed, and isolated-worktree launches do not incur that trade-off.
 */
export function projectScopedTranscriptWarning(
  cmd: string,
  context: { name: string; parented?: boolean; harness?: boolean; isolatedWorktree?: boolean },
): string | undefined {
  const isolation = isolationMechanismForCommand(cmd);
  if (!context.parented || context.harness || context.isolatedWorktree) return undefined;
  if (!isolation.verified || isolation.mechanism !== "project-scoped") return undefined;
  return (
    `agent '${context.name}' uses project-scoped transcript and runtime state in this checkout — ` +
    "other same-user processes may read it; use worktree: true or harness isolation for a private scope"
  );
}

export function assertVerifiedTranscriptIsolation(cmd: string, context: { name: string } & TranscriptIsolationContext): void {
  const isolation = isolationMechanismForCommand(cmd);
  if (hasVerifiedTranscriptIsolation(isolation, context)) return;
  if (isolation.verified && isolation.mechanism === "project-scoped" && !context.isolatedWorktree) {
    return;
  }
  throw new Error(
    `cannot delegate '${context.name}': runtime transcript isolation is not verified ` +
      `(mechanism=${isolation.mechanism}, source=${isolation.source}, verified=${isolation.verified}). ` +
      "Use an isolated harness or add a measured runtime profile before normal delegation.",
  );
}
