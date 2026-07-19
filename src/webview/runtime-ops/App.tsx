import type {
  RuntimeOpsAgentRefV1,
  RuntimeOpsModelV1,
  RuntimeOpsProviderCapacityV2,
  RuntimeOpsProviderQuotaWindowV2,
  RuntimeOpsProviderUnavailableReasonV2,
  RuntimeOpsProviderV2,
  RuntimeOpsRuntimeV1,
  RuntimeOpsSnapshot,
  RuntimeOpsUsageV1,
  RuntimeOpsValue,
} from "../../runtimeOps/types";
import { EmptyState, PageChrome } from "../shared/ui";

const SUMMARY: Array<{ key: keyof RuntimeOpsSnapshot["summary"]; label: string }> = [
  { key: "runtimes", label: "Runtimes" },
  { key: "managedAgents", label: "Managed agents" },
  { key: "activeAgents", label: "Active agents" },
  { key: "throttled", label: "Throttled" },
  { key: "bridgeIssues", label: "Bridge issues" },
];

export function App({
  snapshot,
  onSetProviderObservation,
}: {
  snapshot: RuntimeOpsSnapshot | undefined;
  onSetProviderObservation: (provider: RuntimeOpsProviderV2, enabled: boolean) => void;
}) {
  if (!snapshot) {
    return (
      <main class="runtime-ops" aria-busy="true">
        <PageChrome title="Runtime Ops" icon="graph" hint="Local runtime inventory and provider capacity." />
        <EmptyState kind="loading" message="Loading runtime inventory…" />
      </main>
    );
  }
  if (snapshot.error) {
    return (
      <main class="runtime-ops">
        <PageChrome title="Runtime Ops" icon="graph" hint="Local runtime inventory and provider capacity." />
        <EmptyState
          kind="error"
          message="Runtime inventory unavailable. Runtime Ops could not refresh the inventory."
        />
      </main>
    );
  }
  const providerCapacity = snapshot.schemaVersion === 2 ? snapshot.providerCapacity : [];
  return (
    <main class="runtime-ops">
      <PageChrome title="Runtime Ops" icon="graph" hint="Local runtime inventory and provider capacity." />
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

      {providerCapacity.length > 0 && (
        <ProviderCapacity
          providers={providerCapacity}
          onSetProviderObservation={onSetProviderObservation}
        />
      )}

      <section class="runtime-ops-table" aria-label="Runtime inventory" role="table">
        <div class="runtime-ops-header" role="row" aria-hidden="true">
          <span role="columnheader">Runtime</span><span role="columnheader">Native usage</span><span role="columnheader">Agents</span><span role="columnheader">Last activity</span><span role="columnheader">Version</span>
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

function ProviderCapacity({
  providers,
  onSetProviderObservation,
}: {
  providers: RuntimeOpsProviderCapacityV2[];
  onSetProviderObservation: (provider: RuntimeOpsProviderV2, enabled: boolean) => void;
}) {
  return (
    <section class="runtime-ops-capacity" aria-label="Provider account capacity">
      <header class="runtime-ops-capacity-header">
        <div>
          <h2>Provider capacity</h2>
          <p>Account-wide quota. These limits are not attributed to a runtime, workspace, or agent.</p>
        </div>
      </header>
      <div class="runtime-ops-provider-list">
        {providers.map((provider) => (
          <ProviderCapacityRow
            key={provider.provider}
            provider={provider}
            onSetProviderObservation={onSetProviderObservation}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCapacityRow({
  provider,
  onSetProviderObservation,
}: {
  provider: RuntimeOpsProviderCapacityV2;
  onSetProviderObservation: (provider: RuntimeOpsProviderV2, enabled: boolean) => void;
}) {
  const enabled = provider.configuration.state === "enabled";
  const label = providerLabel(provider.provider);
  return (
    <div
      class={`runtime-ops-provider-row ${provider.quota.state === "available" ? provider.quota.freshness.state : provider.quota.reason}`}
      data-provider={provider.provider}
    >
      <div class="runtime-ops-provider-identity">
        <strong>{label}</strong>
        <span>{providerSourceDisclosure(provider.provider)}</span>
      </div>
      <div class="runtime-ops-provider-quota">
        {provider.quota.state === "available" ? (
          <>
            <div class="runtime-ops-quota-windows">
              {provider.quota.windows.map((window) => <QuotaWindow window={window} key={window.name} />)}
            </div>
            <span class={`runtime-ops-provider-observation ${provider.quota.freshness.state}`}>
              {providerQuotaMetadata(provider)}
            </span>
          </>
        ) : (
          <div class="runtime-ops-provider-unavailable" role={provider.quota.reason === "source-disabled" ? undefined : "status"}>
            <strong>{providerUnavailableLabel(provider.quota.reason)}</strong>
            <span>{providerUnavailableDetail(provider)}</span>
          </div>
        )}
      </div>
      <div class="runtime-ops-provider-control">
        <span>{enabled ? `${enabledSources(provider)} enabled` : "Disabled by default"}</span>
        <button
          type="button"
          aria-label={`${enabled ? "Disable" : "Enable"} ${label} CLI quota observation`}
          aria-pressed={enabled}
          onClick={() => onSetProviderObservation(provider.provider, !enabled)}
        >
          {enabled ? "Disable source" : "Enable CLI"}
        </button>
      </div>
    </div>
  );
}

function QuotaWindow({ window }: { window: RuntimeOpsProviderQuotaWindowV2 }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const exhausted = used >= 100;
  return (
    <div class={`runtime-ops-quota-window${exhausted ? " exhausted" : ""}`}>
      <div class="runtime-ops-quota-label">
        <strong>{quotaWindowLabel(window.name)}</strong>
        <span>{formatPercent(used)} used</span>
      </div>
      <div
        class="runtime-ops-quota-meter"
        role="progressbar"
        aria-label={`${quotaWindowLabel(window.name)} quota used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
      >
        <span style={{ width: `${used}%` }} />
      </div>
      <span class="runtime-ops-quota-reset">
        {window.resetsAt ? `Resets ${formatTimestamp(window.resetsAt)}` : "Reset time unavailable"}
      </span>
    </div>
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
        <div class="runtime-ops-cell" data-label="Native usage" role="cell">
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
            <span role="columnheader">Agent</span><span role="columnheader">Attention</span><span role="columnheader">Model</span><span role="columnheader">Resources</span><span role="columnheader">Context pressure</span><span role="columnheader">Resume</span><span role="columnheader">Bridge</span>
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
      <div class="runtime-ops-cell" data-label="Resources" role="cell"><AgentResources value={agent.resources} /></div>
      <div class="runtime-ops-cell" data-label="Context pressure" role="cell"><ContextPressure value={agent.contextPressure} /></div>
      <div class="runtime-ops-cell" data-label="Resume" role="cell"><strong>{resumeLabel(agent.resume.state)}</strong><span>{resumeDetail(agent.resume.state)}</span></div>
      <div class="runtime-ops-cell" data-label="Bridge" role="cell"><strong class={`runtime-ops-bridge ${agent.bridge.state}`}>{bridge.label}</strong><span>{bridge.detail}</span></div>
    </div>
  );
}

function AgentResources({ value }: { value: RuntimeOpsAgentRefV1["resources"] }) {
  if (!value) return <><strong>—</strong><span>No sample yet</span></>;
  const cpu = value.cpuPct === undefined ? "…" : `${Math.round(value.cpuPct)}%`;
  const mem = value.memMb >= 1024
    ? `${(value.memMb / 1024).toFixed(value.memMb >= 10240 ? 0 : 1).replace(/\.0$/, "")}G`
    : `${Math.round(value.memMb)}M`;
  return <><strong>{cpu} · {mem}</strong><span>CPU · RSS (pane tree)</span></>;
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
      <span>
        {usage.semantics === "latest-cumulative" ? "Latest cumulative snapshot" : "Summed activity deltas"}
        {value.observedAt ? ` · Observed ${formatTimestamp(value.observedAt)}` : ""}
      </span>
    </>
  );
}

function providerLabel(provider: RuntimeOpsProviderV2): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function providerSourceDisclosure(provider: RuntimeOpsProviderV2): string {
  return provider === "codex"
    ? "Read-only Codex CLI app-server; credentials stay with Codex."
    : "Reduced Claude CLI status-line telemetry; no inference turn.";
}

function providerQuotaMetadata(provider: RuntimeOpsProviderCapacityV2): string {
  const quota = provider.quota;
  if (quota.state !== "available") return "";
  const metadata = [
    `Observed ${formatTimestamp(quota.observedAt)}`,
    providerSourceLabel(quota.source),
    `${confidenceLabel(quota.confidence)} confidence`,
  ];
  if (quota.freshness.state === "stale") {
    metadata.push(`Stale; last good ${formatTimestamp(quota.freshness.lastGoodAt)}`);
  } else {
    metadata.push("Fresh");
  }
  return metadata.join(" · ");
}

function providerUnavailableLabel(reason: RuntimeOpsProviderUnavailableReasonV2): string {
  switch (reason) {
    case "source-disabled":
      return "Observation disabled";
    case "unauthenticated":
      return "Authentication required";
    case "timeout":
      return "Provider timed out";
    case "cancelled":
      return "Observation cancelled";
    case "not-observed":
      return "Waiting for quota data";
    case "invalid-payload":
      return "Incompatible quota data";
    case "stale-expired":
      return "Last observation expired";
    case "provider-error":
      return "Provider unavailable";
    case "unsupported":
    default:
      return "Quota source unsupported";
  }
}

function providerUnavailableDetail(provider: RuntimeOpsProviderCapacityV2): string {
  const quota = provider.quota;
  if (quota.state !== "unavailable") return "";
  let detail: string;
  switch (quota.reason) {
    case "source-disabled":
      detail = "Enable the CLI source to observe account-wide quota.";
      break;
    case "unauthenticated":
      detail = "The provider CLI is not authenticated; native usage remains available.";
      break;
    case "timeout":
      detail = "The bounded CLI read timed out; native usage remains available.";
      break;
    case "cancelled":
      detail = "The provider read was cancelled; native usage remains available.";
      break;
    case "not-observed":
      detail = "The source is enabled and awaiting its first valid observation.";
      break;
    case "provider-error":
      detail = "The provider could not supply quota; native usage remains available.";
      break;
    case "invalid-payload":
      detail = "The provider returned an incompatible quota schema; no raw response was retained.";
      break;
    case "stale-expired":
      detail = "The bounded last-good observation is too old to display as current quota.";
      break;
    case "unsupported":
    default:
      detail = "This provider does not expose a supported quota source on this host.";
      break;
  }
  const metadata = quota.reason === "source-disabled"
    ? []
    : [
        quota.source ? providerSourceLabel(quota.source) : undefined,
        `Observed ${formatTimestamp(quota.observedAt)}`,
        quota.lastGoodAt ? `Last good ${formatTimestamp(quota.lastGoodAt)}` : undefined,
      ].filter((value): value is string => value !== undefined);
  return metadata.length > 0 ? `${detail} ${metadata.join(" · ")}.` : detail;
}

function enabledSources(provider: RuntimeOpsProviderCapacityV2): string {
  if (provider.configuration.state !== "enabled") return "No source";
  return provider.configuration.sources.map(providerSourceLabel).join(" + ");
}

function providerSourceLabel(source: "cli" | "oauth"): string {
  return source === "cli" ? "CLI source" : "OAuth source";
}

function confidenceLabel(confidence: "exact" | "estimated" | "unknown"): string {
  if (confidence === "exact") return "Exact";
  if (confidence === "estimated") return "Estimated";
  return "Unknown";
}

function quotaWindowLabel(name: RuntimeOpsProviderQuotaWindowV2["name"]): string {
  if (name === "session") return "Session";
  if (name === "weekly") return "Weekly";
  return "Extended";
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
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
