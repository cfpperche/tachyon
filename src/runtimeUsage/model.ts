export interface RuntimeUsageSource {
  runtime: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  lastActivity?: string;
  agent?: string;
}

export interface RuntimeUsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  timestamp?: string;
}

export interface RuntimeRateLimitSource {
  runtime: string;
  agent: string;
  line?: string;
  resetAt?: number;
}

export interface RuntimeUsageRow {
  runtime: string;
  label: string;
  detail: string;
  description: string;
  status: "available" | "throttled" | "unavailable";
}

const CUMULATIVE_USAGE_RUNTIMES = new Set(["codex"]);

const LABELS: Record<string, string> = {
  agy: "Antigravity",
  aider: "Aider",
  amp: "Amp",
  claude: "Claude",
  codex: "Codex",
  "copilot": "Copilot",
  "cursor-agent": "Cursor Agent",
  gemini: "Gemini",
  goose: "Goose",
  grok: "Grok",
  opencode: "opencode",
  qwen: "Qwen",
};

export function buildRuntimeUsageSource(runtime: string, agent: string, updates: Iterable<RuntimeUsageUpdate>): RuntimeUsageSource | undefined {
  const totals: RuntimeUsageSource = { runtime, agent };
  if (CUMULATIVE_USAGE_RUNTIMES.has(runtime)) {
    let latest: RuntimeUsageUpdate | undefined;
    for (const update of updates) {
      if (update.timestamp && (!totals.lastActivity || update.timestamp > totals.lastActivity)) totals.lastActivity = update.timestamp;
      latest = update;
    }
    if (latest) {
      totals.inputTokens = latest.inputTokens;
      totals.outputTokens = latest.outputTokens;
      totals.cacheReadTokens = latest.cacheReadTokens;
      totals.cacheCreationTokens = latest.cacheCreationTokens;
    }
  } else {
    for (const update of updates) {
      totals.inputTokens = (totals.inputTokens ?? 0) + (update.inputTokens ?? 0);
      totals.outputTokens = (totals.outputTokens ?? 0) + (update.outputTokens ?? 0);
      totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + (update.cacheReadTokens ?? 0);
      totals.cacheCreationTokens = (totals.cacheCreationTokens ?? 0) + (update.cacheCreationTokens ?? 0);
      if (update.timestamp && (!totals.lastActivity || update.timestamp > totals.lastActivity)) totals.lastActivity = update.timestamp;
    }
  }
  return hasAnyTokenUsage(totals) ? totals : undefined;
}

export function buildRuntimeUsageRows(
  detectedRuntimes: string[],
  usageSources: RuntimeUsageSource[],
  rateLimits: RuntimeRateLimitSource[] = [],
): RuntimeUsageRow[] {
  const detected = [...new Set(detectedRuntimes)].sort((a, b) => runtimeLabel(a).localeCompare(runtimeLabel(b)));
  const byRuntime = new Map<string, Required<Pick<RuntimeUsageSource, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">> & { agents: Set<string>; lastActivity?: string }>();
  for (const src of usageSources) {
    const cur = byRuntime.get(src.runtime) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, agents: new Set<string>() };
    cur.inputTokens += src.inputTokens ?? 0;
    cur.outputTokens += src.outputTokens ?? 0;
    cur.cacheReadTokens += src.cacheReadTokens ?? 0;
    cur.cacheCreationTokens += src.cacheCreationTokens ?? 0;
    if (src.agent) cur.agents.add(src.agent);
    if (src.lastActivity && (!cur.lastActivity || src.lastActivity > cur.lastActivity)) cur.lastActivity = src.lastActivity;
    byRuntime.set(src.runtime, cur);
  }
  const throttleByRuntime = new Map<string, RuntimeRateLimitSource>();
  for (const rate of rateLimits) if (!throttleByRuntime.has(rate.runtime)) throttleByRuntime.set(rate.runtime, rate);

  return detected.map((runtime) => {
    const usage = byRuntime.get(runtime);
    const throttle = throttleByRuntime.get(runtime);
    const status: RuntimeUsageRow["status"] = throttle ? "throttled" : usage && hasTokenUsage(usage) ? "available" : "unavailable";
    const description = throttle ? throttleDescription(throttle) : usage ? usageDescription(usage) : "installed; usage unavailable";
    return {
      runtime,
      label: `${status === "throttled" ? "$(warning) " : "$(pulse) "}${runtimeLabel(runtime)}`,
      detail: usage && hasTokenUsage(usage) ? tokenDetail(usage) : "usage unavailable",
      description,
      status,
    };
  });
}

export function runtimeLabel(runtime: string): string {
  return LABELS[runtime] ?? runtime;
}

export function runtimeUsageSemantics(runtime: string): "latest-cumulative" | "summed-deltas" {
  return CUMULATIVE_USAGE_RUNTIMES.has(runtime) ? "latest-cumulative" : "summed-deltas";
}

function hasAnyTokenUsage(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }): boolean {
  return (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0 || (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheCreationTokens ?? 0) > 0;
}

function hasTokenUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0;
}

function tokenDetail(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): string {
  const base = `${fmtTokens(usage.inputTokens)} in / ${fmtTokens(usage.outputTokens)} out`;
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  return cache > 0 ? `${base} / ${fmtTokens(cache)} cache` : base;
}

function usageDescription(usage: { agents: Set<string>; lastActivity?: string }): string {
  const agents = usage.agents.size === 1 ? "1 agent" : `${usage.agents.size} agents`;
  return usage.lastActivity ? `${agents}; last usage ${usage.lastActivity}` : agents;
}

function throttleDescription(throttle: RuntimeRateLimitSource): string {
  const reset = throttle.resetAt ? `; reset ${new Date(throttle.resetAt).toLocaleString()}` : "";
  const line = throttle.line ? `; ${throttle.line}` : "";
  return `${throttle.agent} throttled${reset}${line}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
