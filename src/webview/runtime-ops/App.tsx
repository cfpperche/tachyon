import type { RuntimeOpsAgentRefV1, RuntimeOpsRuntimeV1, RuntimeOpsSnapshotV1, RuntimeOpsUsageV1, RuntimeOpsValue } from "../../runtimeOps/types";

const SUMMARY: Array<{ key: keyof RuntimeOpsSnapshotV1["summary"]; label: string }> = [
  { key: "runtimes", label: "Runtimes" },
  { key: "managedAgents", label: "Managed agents" },
  { key: "activeAgents", label: "Active agents" },
  { key: "throttled", label: "Throttled" },
  { key: "bridgeIssues", label: "Bridge issues" },
];

export function App({ snapshot }: { snapshot: RuntimeOpsSnapshotV1 | undefined }) {
  if (!snapshot) return <main class="runtime-ops"><div class="runtime-ops-state">Loading runtime inventory...</div></main>;
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
        <time class="runtime-ops-updated" dateTime={snapshot.generatedAt}>
          Snapshot {new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </time>
      </section>

      <section class="runtime-ops-table" aria-label="Runtime inventory">
        <div class="runtime-ops-header" aria-hidden="true">
          <span>Runtime</span><span>Usage</span><span>Agents</span><span>Last activity</span><span>Version</span>
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
    <div class="runtime-ops-runtime-group">
      <article class="runtime-ops-row">
        <div class="runtime-ops-cell runtime-ops-runtime" data-label="Runtime">
          <strong>{runtime.label}</strong>
          <span>{runtime.availability.detail}</span>
        </div>
        <div class="runtime-ops-cell" data-label="Usage">
          <Usage value={runtime.usage} />
        </div>
        <div class="runtime-ops-cell" data-label="Agents">
          <strong>{runtime.agents.length} managed</strong>
          <span>{workspaceLabels || "No managed workspace"}</span>
        </div>
        <div class="runtime-ops-cell" data-label="Last activity">
          <SourcedText value={runtime.lastActivity} format={formatTimestamp} />
        </div>
        <div class="runtime-ops-cell" data-label="Version">
          <SourcedText value={runtime.version} />
        </div>
      </article>
      {runtime.agents.length > 0 && (
        <details class="runtime-ops-agents">
          <summary>{runtime.agents.length === 1 ? "1 agent detail" : `${runtime.agents.length} agent details`}</summary>
          <div class="runtime-ops-agent-header" aria-hidden="true">
            <span>Agent</span><span>Attention</span><span>Model</span><span>Context pressure</span><span>Resume</span><span>Bridge</span>
          </div>
          {runtime.agents.map((agent) => <AgentRow agent={agent} workspaces={runtime.workspaces} key={agent.key} />)}
        </details>
      )}
    </div>
  );
}

function AgentRow({ agent, workspaces }: { agent: RuntimeOpsAgentRefV1; workspaces: RuntimeOpsRuntimeV1["workspaces"] }) {
  const workspace = workspaces.find((item) => item.key === agent.workspaceKey)?.label ?? "Unknown workspace";
  const attention = agent.attention.rateLimit
    ? `${agent.attention.rateLimit.message}${agent.attention.rateLimit.scope ? ` (${agent.attention.rateLimit.scope})` : ""}${agent.attention.rateLimit.resetAt ? `; reset ${formatTimestamp(new Date(agent.attention.rateLimit.resetAt).toISOString())}` : ""}`
    : agent.attention.state;
  const bridgeDetail = [agent.bridge.reason,
    agent.bridge.currentGeneration !== undefined ? `host ${agent.bridge.currentGeneration}` : undefined,
    agent.bridge.boundGeneration !== undefined ? `bound ${agent.bridge.boundGeneration}` : undefined,
  ].filter(Boolean).join("; ");
  return (
    <div class="runtime-ops-agent-row">
      <div class="runtime-ops-cell" data-label="Agent"><strong>{agent.name}</strong><span>{workspace} · {agent.status}</span></div>
      <div class="runtime-ops-cell" data-label="Attention"><strong>{attention}</strong><span>{agent.attention.stale ? "Stale monitor snapshot" : "Current monitor snapshot"}</span></div>
      <div class="runtime-ops-cell" data-label="Model"><SourcedText value={agent.model} /></div>
      <div class="runtime-ops-cell" data-label="Context pressure"><ContextPressure value={agent.contextPressure} /></div>
      <div class="runtime-ops-cell" data-label="Resume"><strong>{resumeLabel(agent.resume.state)}</strong><span>{agent.resume.reason}</span></div>
      <div class="runtime-ops-cell" data-label="Bridge"><strong class={`runtime-ops-bridge ${agent.bridge.state}`}>{agent.bridge.state}</strong><span title={bridgeDetail}>{bridgeDetail}</span></div>
    </div>
  );
}

function ContextPressure({ value }: { value: RuntimeOpsAgentRefV1["contextPressure"] }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span>{value.reason}</span></>;
  const percentage = value.value.limit > 0 ? ` (${Math.round((value.value.used / value.value.limit) * 100)}%)` : "";
  return <><strong>{formatTokens(value.value.used)} / {formatTokens(value.value.limit)}{percentage}</strong><span>Used / limit</span></>;
}

function Usage({ value }: { value: RuntimeOpsValue<RuntimeOpsUsageV1> }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span title={value.reason}>{value.reason}</span></>;
  const usage = value.value;
  const cache = usage.cacheReadTokens + usage.cacheCreationTokens;
  return (
    <>
      <strong>{formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out{cache > 0 ? ` / ${formatTokens(cache)} cache` : ""}</strong>
      <span>{usage.semantics === "latest-cumulative" ? "Latest cumulative snapshot" : "Summed activity deltas"}</span>
    </>
  );
}

function SourcedText({ value, format = (text) => text }: { value: RuntimeOpsValue<string>; format?: (text: string) => string }) {
  if (value.state === "unavailable") return <><strong>Unavailable</strong><span title={value.reason}>{value.reason}</span></>;
  const source = value.source === "command" ? "Command-line model" : value.source === "runtime-profile" ? "Configured runtime default" : "Observed in normalized activity";
  return <><strong>{format(value.value)}</strong><span>{source}</span></>;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function resumeLabel(state: RuntimeOpsAgentRefV1["resume"]["state"]): string {
  if (state === "fresh-start-only") return "Fresh start only";
  if (state === "not-resumable") return "Not resumable";
  return state === "live" ? "Live" : "Resumable";
}
