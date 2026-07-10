import type { RuntimeOpsSnapshotV1 } from "../../runtimeOps/types";

const SUMMARY: Array<{ key: keyof RuntimeOpsSnapshotV1["summary"]; label: string }> = [
  { key: "runtimes", label: "Runtimes" },
  { key: "activeAgents", label: "Active agents" },
  { key: "throttled", label: "Throttled" },
  { key: "bridgeIssues", label: "Bridge issues" },
];

export function App({ snapshot }: { snapshot: RuntimeOpsSnapshotV1 | undefined }) {
  if (!snapshot) return <main class="runtime-ops"><div class="runtime-ops-state">Loading runtime inventory...</div></main>;
  return (
    <main class="runtime-ops">
      <section class="runtime-ops-summary" aria-label="Runtime summary">
        {SUMMARY.map(({ key, label }) => (
          <div class="runtime-ops-summary-item" key={key}>
            <span class="runtime-ops-summary-value">{snapshot.summary[key]}</span>
            <span class="runtime-ops-summary-label">{label}</span>
          </div>
        ))}
        <time class="runtime-ops-updated" dateTime={snapshot.generatedAt}>
          Snapshot {new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </time>
      </section>

      <section class="runtime-ops-table" aria-label="Runtime inventory">
        <div class="runtime-ops-header" aria-hidden="true">
          <span>Runtime</span><span>Usage</span><span>Agents</span><span>Attention</span><span>Bridge</span>
        </div>
        <div class="runtime-ops-state">
          <strong>Runtime inventory unavailable.</strong>
          <span>Runtime data collection is not wired in this build.</span>
        </div>
      </section>
    </main>
  );
}
