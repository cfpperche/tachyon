import { binaryOf, runtimeOf, type ResumeRuntime } from "../resume/adapters.js";

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
  /** Runtime-specific line that marks the start of the human-editable composer. */
  promptLine: RegExp;
}

export interface RuntimeModelProfile extends RuntimeProfileSection {
  /** Human-readable fallback when the command does not pin a model flag. */
  defaultModel: string;
  /** Known runtime-specific ids/shorthands normalized for the sidebar. Keys are matched case-insensitively. */
  aliases?: Record<string, string>;
}

export type GracefulStopStep =
  | { type: "interruptActiveTurn" }
  | { type: "sendKey"; key: string }
  | { type: "sendKeyIfAliveAfterDelay"; key: string; delayMs: number };

export interface GracefulStopProfile extends RuntimeProfileSection {
  steps: GracefulStopStep[];
}

export interface RuntimeProfile {
  runtime: ResumeRuntime;
  profileVersion: number;
  model?: RuntimeModelProfile;
  isolation: IsolationProfile;
  composer?: ComposerRegionProfile;
  gracefulStop?: GracefulStopProfile;
}

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
  claude: {
    runtime: "claude",
    profileVersion: 1,
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
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?>\s?.*$/,
      source: "declared",
      verified: false,
      notes: "t-f30324: Claude's human input composer is a bottom-of-pane prompt line beginning with '>'.",
    },
    gracefulStop: {
      steps: [
        { type: "interruptActiveTurn" },
        { type: "sendKey", key: "C-c" },
        { type: "sendKey", key: "C-d" },
        { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
      ],
      source: "declared",
      verified: false,
      notes: "Byte-identical to the pre-t-bae032 Claude path: interrupt active turn, clear composer, EOF, then retry EOF if still alive.",
    },
  },
  codex: {
    runtime: "codex",
    profileVersion: 1,
    model: {
      defaultModel: "Codex default",
      aliases: {
        "gpt-5.1-codex": "GPT-5.1 Codex",
        "gpt-5-codex": "GPT-5 Codex",
      },
      source: "declared",
      verified: false,
      notes: "t-140242 v1: command --model wins; bare codex falls back to this profile label until config/session introspection lands.",
    },
    isolation: {
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-05",
      notes: "Spec 357: Tachyon-spawned Codex agents use per-agent private CODEX_HOME directories.",
    },
    composer: {
      tailLines: 8,
      promptLine: /^\s*(?:[│┃]\s*)?(?:❯|>|›)\s?.*$/,
      source: "declared",
      verified: false,
      notes: "t-f30324: Codex's human input composer is a bottom-of-pane prompt line beginning with '❯'/'>'/'›'.",
    },
    gracefulStop: {
      steps: [{ type: "interruptActiveTurn" }, { type: "sendKey", key: "C-d" }],
      source: "declared",
      verified: false,
      notes: "Byte-identical to the pre-t-bae032 Codex path: interrupt an active turn when present, then EOF.",
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
    gracefulStop: {
      steps: [{ type: "sendKey", key: "C-d" }],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
      notes: "t-bae032 journal: opencode 1.17.15 exits on bare Ctrl-D, so keep the existing EOF path working.",
    },
  },
};

export function runtimeProfile(runtime: ResumeRuntime): RuntimeProfile | undefined {
  return RUNTIME_PROFILES[runtime];
}

export function gracefulStopForCommand(cmd: string): GracefulStopProfile {
  const runtime = runtimeOf(cmd);
  if (runtime) return runtimeProfile(runtime)?.gracefulStop ?? DEFAULT_GRACEFUL_STOP;
  if (binaryOf(cmd) === "grok") return GROK_GRACEFUL_STOP;
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
