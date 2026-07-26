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
  /** Runtime-specific ANSI style rule that can make otherwise non-empty prompt content count as empty. */
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

const GROK_GRACEFUL_STOP: GracefulStopProfile = {
  steps: [
    { type: "sendKey", key: "C-c" },
    { type: "sendKey", key: "C-c" },
  ],
  source: "measured",
  verified: true,
  verifiedAt: "2026-07-08",
  notes: "t-bae032 journal: grok exits on Ctrl-C then Ctrl-C; bare Ctrl-D and single Ctrl-C stay alive.",
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
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-19",
      notes:
        "t-3fe20f: live Claude Code CLI renders its composer prompt as U+276F '❯' (measured on tachyon-b349073a-claude, " +
        "raw bytes e2 9d af), not ASCII '>'; the unmeasured t-f30324 regex never matched, permanently wedging isReady() " +
        "for every claude-runtime agent once LAUNCH_READINESS_RUNTIMES started gating claude (t-9d2299).",
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
      ],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-25",
      notes:
        "Canonical profiles regenerate the selected approval_policy and sandbox_mode in private CODEX_HOME/config.toml on fresh/restart/resume " +
        "(t-1a3d50). Codex CLI 0.145.0 accepted every declared key/value under --strict-config. This does not apply a policy to legacy arbitrary commands.",
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
        "Grok has native -w/--worktree support. Canonical profiles additionally regenerate a private GROK_HOME and HOME, but legacy/ad-hoc Grok commands remain project-scoped, so runtime-wide transcript isolation is not yet declared.",
    },
    permission: {
      modes: ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"],
      alwaysApproveFlag: "--always-approve",
      source: "measured",
      verified: false,
      verifiedAt: "2026-07-25",
      notes: "Grok 0.2.112 accepts every listed --permission-mode value and rejects invalid input. Canonical HOME isolation excludes ambient Claude settings, but no authored permission-policy projection exists yet; never infer --always-approve or bypassPermissions.",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      occupiedLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?\S.*$/,
      source: "assumed",
      verified: false,
      notes: "t-f45313: conservative Claude/Codex-shaped composer guard for Grok dogfood pane-injection safety; exact prompt shape still needs runtime measurement.",
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
 * different tier than an ad-hoc delegated spawn — so a declared opencode agent with no `harness:`
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

export function assertVerifiedTranscriptIsolation(cmd: string, context: { name: string } & TranscriptIsolationContext): void {
  const isolation = isolationMechanismForCommand(cmd);
  if (hasVerifiedTranscriptIsolation(isolation, context)) return;
  if (isolation.verified && isolation.mechanism === "project-scoped" && !context.isolatedWorktree) {
    const remedy = context.parented
      ? "Spawn with worktree: true to create a child worktree, use a gated delegation, or set cwd to a registered Tachyon worktree."
      : "Use a gated delegation, spawn with worktree: true, or set cwd to a registered Tachyon worktree.";
    throw new Error(
      `cannot delegate '${context.name}': this runtime's project-scoped transcript isolation requires an isolated worktree for this spawn ` +
        `(mechanism=${isolation.mechanism}, source=${isolation.source}, verified=${isolation.verified}). ` +
        remedy,
    );
  }
  throw new Error(
    `cannot delegate '${context.name}': runtime transcript isolation is not verified ` +
      `(mechanism=${isolation.mechanism}, source=${isolation.source}, verified=${isolation.verified}). ` +
      "Use an isolated harness or add a measured runtime profile before normal delegation.",
  );
}
