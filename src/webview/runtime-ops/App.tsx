import type { RuntimeOpsAgentRefV1, RuntimeOpsModelV1, RuntimeOpsRuntimeV1, RuntimeOpsSnapshotV1, RuntimeOpsUsageV1, RuntimeOpsValue } from "../../runtimeOps/types";

const SUMMARY: Array<{ key: keyof RuntimeOpsSnapshotV1["summary"]; label: string }> = [
  { key: "runtimes", label: "Runtimes" },
  { key: "managedAgents", label: "Managed agents" },
  { key: "activeAgents", label: "Active agents" },
  { key: "throttled", label: "Throttled" },
  { key: "bridgeIssues", label: "Bridge issues" },
];

export function App({ snapshot }: { snapshot: RuntimeOpsSnapshotV1 | undefined }) {
  if (!snapshot) {
    return <main class="runtime-ops" aria-busy="true"><div class="runtime-ops-state">Loading runtime inventory...</div></main>;
  }
  if (snapshot.error) {
    return (
      <main class="runtime-ops">
        <section class="runtime-ops-state runtime-ops-error" role="alert">
          <strong>Runtime inventory unavailable.</strong>
          <span>Runtime Ops could not refresh the inventory.</span>
          <a class="runtime-ops-refresh" href="command:tachyon.refreshRuntimeOps">Refresh</a>
        </section>
      </main>
    );
  }
  return (
    <main class="runtime-ops">
      <section class="runtime-ops-summary" aria-label="Runtime summary">
        {SUMMARY.map(({ key, label }) => (
          <div class="runtime-ops-summary-item" key={key}>
            <span class="runtime-ops-summary-value">{snapshot.summary[key] ?? "—"}</span>
            <span class="runtime-ops-summary-label">{label}</span>
          </div>
        ))}
        <time class="runtime-ops-updated" dateTime={validDateTime(snapshot.generatedAt)}>
          Snapshot {formatTimestamp(snapshot.generatedAt)}
        </time>
      </section>

      <section class="runtime-ops-table" aria-label="Runtime inventory" role="table">
        <div class="runtime-ops-header" role="row" aria-hidden="true">
          <span role="columnheader">Runtime</span><span role="columnheader">Usage</span><span role="columnheader">Agents</span><span role="columnheader">Last activity</span><span role="columnheader">Version</span>
        </div>
        {snapshot.runtimes.length === 0 ? (
          <div class="runtime-ops-state">
            <strong>No supported runtimes found.</strong>
            <span>PATH detection and managed session ledgers returned no runtime inventory.</span>
          </div>
        ) : snapshot.runtimes.map((runtime) => <RuntimeRow runtime={runtime} key={runtime.key} />)}
      </section>
    </main>
  );
}

function RuntimeRow({ runtime }: { runtime: RuntimeOpsRuntimeV1 }) {
  const workspaceLabels = runtime.workspaces.map((workspace) => workspace.label).join(", ");
  return (
    <div class="runtime-ops-runtime-group" role="rowgroup">
      <div class="runtime-ops-row" role="row">
        <div class="runtime-ops-cell runtime-ops-runtime" data-label="Runtime" role="cell">
          <strong>{runtime.label}</strong>
          <span>{availabilityCopy(runtime)}</span>
        </div>
        <div class="runtime-ops-cell" data-label="Usage" role="cell">
          <Usage value={runtime.usage} />
        </div>
        <div class="runtime-ops-cell" data-label="Agents" role="cell">
          <strong>{runtime.agents.length} managed</strong>
          <span>{workspaceLabels || "No managed workspace"}</span>
        </div>
        <div class="runtime-ops-cell" data-label="Last activity" role="cell">
          <SourcedText value={runtime.lastActivity} kind="activity" format={formatTimestamp} />
        </div>
        <div class="runtime-ops-cell" data-label="Version" role="cell">
          <SourcedText value={runtime.version} kind="version" />
        </div>
      </div>
      {runtime.agents.length > 0 && (
        <details class="runtime-ops-agents" aria-label={`Agent details for ${runtime.label}`}>
          <summary>{runtime.agents.length === 1 ? "1 agent detail" : `${runtime.agents.length} agent details`}</summary>
          <div class="runtime-ops-agent-header" role="row" aria-hidden="true">
            <span role="columnheader">Agent</span><span role="columnheader">Attention</span><span role="columnheader">Model</span><span role="columnheader">Context pressure</span><span role="columnheader">Resume</span><span role="columnheader">Bridge</span>
          </div>
          {runtime.agents.map((agent) => <AgentRow agent={agent} workspaces={runtime.workspaces} key={agent.key} />)}
        </details>
      )}
    </div>
  );
}

function AgentRow({ agent, workspaces }: { agent: RuntimeOpsAgentRefV1; workspaces: RuntimeOpsRuntimeV1["workspaces"] }) {
  const workspace = workspaces.find((item) => item.key === agent.workspaceKey)?.label ?? "Unknown workspace";
  const attention = attentionCopy(agent);
  const bridge = bridgeCopy(agent);
  return (
    <div class="runtime-ops-agent-row" role="row" data-agent-key={agent.key}>
      <div class="runtime-ops-cell" data-label="Agent" role="cell"><strong>{agent.name}</strong><span>{workspace} · {agent.status}</span></div>
      <div class="runtime-ops-cell" data-label="Attention" role="cell"><strong>{attention.primary}</strong><span>{attention.detail}</span></div>
      <div class="runtime-ops-cell" data-label="Model" role="cell"><Model value={agent.model} /></div>
      <div class="runtime-ops-cell" data-label="Context pressure" role="cell"><ContextPressure value={agent.contextPressure} /></div>
      <div class="runtime-ops-cell" data-label="Resume" role="cell"><strong>{resumeLabel(agent.resume.state)}</strong><span>{resumeDetail(agent.resume.state)}</span></div>
      <div class="runtime-ops-cell" data-label="Bridge" role="cell"><strong class={`runtime-ops-bridge ${agent.bridge.state}`}>{bridge.label}</strong><span>{bridge.detail}</span></div>
    </div>
  );
}

function ContextPressure({ value }: { value: RuntimeOpsAgentRefV1["contextPressure"] }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span>No normalized context window is available.</span></>;
  const percentage = value.value.limit > 0 ? ` (${Math.round((value.value.used / value.value.limit) * 100)}%)` : "";
  return <><strong>{formatTokens(value.value.used)} / {formatTokens(value.value.limit)}{percentage}</strong><span>Used / limit</span></>;
}

function Usage({ value }: { value: RuntimeOpsValue<RuntimeOpsUsageV1> }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span>No normalized usage data is available.</span></>;
  const usage = value.value;
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    <>
      <strong>{formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out{cache > 0 ? ` / ${formatTokens(cache)} cache` : ""}</strong>
      <span>{usage.semantics === "latest-cumulative" ? "Latest cumulative snapshot" : "Summed activity deltas"}</span>
    </>
  );
}

function SourcedText({ value, kind, format = (text) => text }: { value: RuntimeOpsValue<string>; kind: "activity" | "version"; format?: (text: string) => string }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span>{unavailableCopy(kind)}</span></>;
  const source = sourceCopy(value.source);
  return <><strong>{format(value.value)}</strong><span>{source}</span></>;
}

function Model({ value }: { value: RuntimeOpsModelV1 }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span>{unavailableCopy("model")}</span></>;
  const label = modelLabel(value.value);
  if (!label) return <><strong>Unavailable</strong><span>{unavailableCopy("model")}</span></>;
  return <><strong>{label}</strong><span>{modelSourceCopy(value.source)}</span></>;
}

function availabilityCopy(runtime: RuntimeOpsRuntimeV1): string {
  if (runtime.availability.pathDetected && runtime.availability.managed) return "PATH detected; managed sessions observed";
  if (runtime.availability.pathDetected) return "PATH detected; authentication not checked";
  if (runtime.availability.managed) return "Managed session observed; PATH not detected in this host";
  return "Runtime source is unavailable.";
}

function unavailableCopy(kind: "activity" | "model" | "version"): string {
  if (kind === "activity") return "No normalized activity timestamp is available.";
  if (kind === "model") return "No configured or command-line model is available.";
  return "No normalized runtime version is available.";
}

function sourceCopy(source: unknown): string {
  switch (source) {
    case "activity-log":
      return "Observed in normalized activity";
    case "path":
      return "PATH detection";
    case "session-ledger":
      return "Recorded session state";
    case "command":
      return "Command-line source";
    case "runtime-profile":
      return "Configured runtime profile";
    default:
      return "Normalized source unavailable";
  }
}

function modelLabel(value: unknown): string | undefined {
  switch (value) {
    case "Claude default":
    case "Opus":
    case "Opus 4.8":
    case "Sonnet":
    case "Sonnet 5":
    case "Haiku":
    case "Codex default":
    case "GPT-5.1 Codex":
    case "GPT-5 Codex":
    case "Grok default":
      return value;
    default:
      return undefined;
  }
}

function modelSourceCopy(source: unknown): string {
  switch (source) {
    case "command":
      return "Command-line model";
    case "runtime-profile":
      return "Configured runtime default";
    default:
      return "Normalized model source unavailable";
  }
}

function attentionCopy(agent: RuntimeOpsAgentRefV1): { primary: string; detail: string } {
  const rateLimit = agent.attention.rateLimit;
  if (rateLimit) {
    const runtime = throttleRuntimeCopy(rateLimit.runtime);
    const scope = throttleScopeCopy(rateLimit.scope);
    const unknown = !runtime && !scope
      ? "Throttle runtime and scope unavailable"
      : !runtime
        ? "Throttle runtime unavailable"
        : !scope
          ? "Throttle scope unavailable"
          : undefined;
    const detail = [runtime, scope, unknown, rateLimit.resetAt ? `resets ${formatTimestamp(new Date(rateLimit.resetAt).toISOString())}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    return { primary: "Throttled - see agent terminal", detail: detail || "Normalized throttle metadata unavailable." };
  }
  return {
    primary: attentionLabel(agent.attention.state),
    detail: agent.attention.stale ? "Stale monitor snapshot" : "Current monitor snapshot",
  };
}

function attentionLabel(state: RuntimeOpsAgentRefV1["attention"]["state"]): string {
  switch (state) {
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "needs-input":
      return "Needs input";
    case "throttled":
      return "Throttled";
    case "unknown":
    default:
      return "Unknown";
  }
}

function throttleRuntimeCopy(value: unknown): string | undefined {
  switch (value) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "opencode";
    default:
      return undefined;
  }
}

function throttleScopeCopy(value: unknown): string | undefined {
  switch (value) {
    case "5h":
      return "5-hour window";
    case "weekly":
      return "Weekly window";
    default:
      return undefined;
  }
}

function bridgeCopy(agent: RuntimeOpsAgentRefV1): { label: string; detail: string } {
  const generations = agent.bridge.currentGeneration !== undefined && agent.bridge.boundGeneration !== undefined
    ? `Host ${agent.bridge.currentGeneration}; bound ${agent.bridge.boundGeneration}.`
    : undefined;
  const detail = bridgeDetail(agent.bridge.state);
  return { label: bridgeLabel(agent.bridge.state), detail: [detail, generations].filter(Boolean).join(" ") };
}

function bridgeLabel(state: RuntimeOpsAgentRefV1["bridge"]["state"]): string {
  switch (state) {
    case "ok":
      return "OK";
    case "suspect":
      return "Suspect";
    case "rebinding":
      return "Rebinding";
    case "failed":
      return "Failed";
    case "not-wired":
      return "Not wired";
    case "unknown":
    default:
      return "Unknown";
  }
}

function bridgeDetail(state: RuntimeOpsAgentRefV1["bridge"]["state"]): string {
  switch (state) {
    case "ok":
      return "Wired and bound to the current host generation.";
    case "suspect":
      return "Bridge binding needs attention.";
    case "rebinding":
      return "Bridge client rebind is in progress.";
    case "failed":
      return "Bridge client rebind failed.";
    case "not-wired":
      return "Bridge client materialization is not recorded.";
    case "unknown":
    default:
      return "Bridge state cannot be confirmed.";
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Timestamp unavailable" : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function validDateTime(value: string): string | undefined {
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

function resumeLabel(state: RuntimeOpsAgentRefV1["resume"]["state"]): string {
  if (state === "fresh-start-only") return "Fresh start only";
  if (state === "not-resumable") return "Not resumable";
  return state === "live" ? "Live" : "Resumable";
}

function resumeDetail(state: RuntimeOpsAgentRefV1["resume"]["state"]): string {
  if (state === "live") return "Agent process is currently live.";
  if (state === "resumable") return "A resumable session is recorded.";
  if (state === "fresh-start-only") return "Resume requires a fresh start.";
  return "No resumable session is recorded.";
}
