import { runtimeOf, type ResumeRuntime } from "../resume/adapters.js";

export type RuntimeProfileSource = "measured" | "declared" | "assumed";
export type IsolationMechanism = "mint" | "private-home" | "unknown" | "none";

export interface RuntimeProfileSection {
  source: RuntimeProfileSource;
  verified: boolean;
  verifiedAt?: string;
  notes?: string;
}

export interface IsolationProfile extends RuntimeProfileSection {
  mechanism: IsolationMechanism;
}

export interface ComposerRegionProfile extends RuntimeProfileSection {
  /** How far from the pane bottom Tachyon should look for the runtime input composer. */
  tailLines: number;
  /** Runtime-specific line that marks the start of the human-editable composer. */
  promptLine: RegExp;
}

export interface RuntimeProfile {
  runtime: ResumeRuntime;
  profileVersion: number;
  isolation: IsolationProfile;
  composer?: ComposerRegionProfile;
}

export const RUNTIME_PROFILES: Partial<Record<ResumeRuntime, RuntimeProfile>> = {
  claude: {
    runtime: "claude",
    profileVersion: 1,
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
};

export function runtimeProfile(runtime: ResumeRuntime): RuntimeProfile | undefined {
  return RUNTIME_PROFILES[runtime];
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

export function hasVerifiedTranscriptIsolation(isolation: IsolationProfile): boolean {
  return isolation.verified && (isolation.mechanism === "mint" || isolation.mechanism === "private-home");
}

export function assertVerifiedTranscriptIsolation(cmd: string, context: { name: string }): void {
  const isolation = isolationMechanismForCommand(cmd);
  if (hasVerifiedTranscriptIsolation(isolation)) return;
  throw new Error(
    `cannot delegate '${context.name}': runtime transcript isolation is not verified ` +
      `(mechanism=${isolation.mechanism}, source=${isolation.source}, verified=${isolation.verified}). ` +
      "Use an isolated harness or add a measured runtime profile before normal delegation.",
  );
}
