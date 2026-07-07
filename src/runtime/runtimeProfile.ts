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
  /** Runtime-specific line that marks the start of the human-editable composer. */
  promptLine: RegExp;
}

export interface RuntimeModelProfile extends RuntimeProfileSection {
  /** Human-readable fallback when the command does not pin a model flag. */
  defaultModel: string;
  /** Known runtime-specific ids/shorthands normalized for the sidebar. Keys are matched case-insensitively. */
  aliases?: Record<string, string>;
}

export interface RuntimeProfile {
  runtime: ResumeRuntime;
  profileVersion: number;
  model?: RuntimeModelProfile;
  isolation: IsolationProfile;
  composer?: ComposerRegionProfile;
}

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
  },
  opencode: {
    runtime: "opencode",
    profileVersion: 1,
    isolation: {
      mechanism: "project-scoped",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-07",
      notes: "t-6a5dae: opencode stores sessions in project-scoped storage; safe for gated delegation when agents run in isolated worktrees, but same-project agents can share transcript namespace.",
    },
  },
};

export function runtimeProfile(runtime: ResumeRuntime): RuntimeProfile | undefined {
  return RUNTIME_PROFILES[runtime];
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
