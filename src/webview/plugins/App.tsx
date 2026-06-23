import type { InstalledPluginVM, PluginsViewModel, PluginStatus, RuntimePill } from "../../plugins/viewModel";

// spec 250 — the Plugins View (Preact, render-only). Step B: a read-only render of the installed list
// from the host-gathered VM (header + workspace-runtime subtitle, cold/empty + corrupt-lockfile states,
// and one card per installed plugin with provenance, per-plugin runtime pills, and a status badge).
// Install-by-source, the security consent drawer, and the action buttons land in Step C.

export interface PluginsDispatch {
  refresh(): void;
}

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

/** Status → (badge tone, label). `unknown` (not yet checked) renders no badge — Step C adds the check. */
function statusBadge(status: PluginStatus): { tone: string; label: string } | null {
  switch (status.kind) {
    case "up-to-date":
      return { tone: "ok", label: "up to date" };
    case "update-available":
      return { tone: "warn", label: `update available${status.latestVersion ? ` · v${status.latestVersion}` : ""}` };
    case "drift":
      return { tone: "err", label: "drift · edited locally" };
    case "conflict":
      return { tone: "err", label: "conflict" };
    case "error":
      return { tone: "err", label: status.detail ? `error · ${status.detail}` : "error" };
    case "unknown":
      return null;
  }
}

function RuntimePillView({ pill }: { pill: RuntimePill }) {
  const cls = pill.present ? "rt has" : "rt miss";
  const title = pill.present ? "materialized & present" : "materialized for this runtime, but it is no longer in the workspace";
  return <span class={cls} title={title}>{pill.runtime} {pill.present ? "✓" : "—"}</span>;
}

function Card({ p }: { p: InstalledPluginVM }) {
  const badge = statusBadge(p.status);
  return (
    <div class="card">
      <div class="card-top">
        <span class="pname">{p.name}</span>
        <span class="pver">v{p.version}</span>
        {badge && <span class={`badge ${badge.tone}`}>{badge.label}</span>}
      </div>
      <div class="pmeta">
        {p.sourceSpec
          ? <span class="src">{p.sourceSpec}</span>
          : <span class="dim">local dir install</span>}
        {p.shortCommit && <><span>·</span><span class="mono dim">{p.shortCommit}</span></>}
        <span>·</span>
        {p.runtimes.map((pill) => <RuntimePillView key={pill.runtime} pill={pill} />)}
      </div>
    </div>
  );
}

export function App({ vm, dispatch }: { vm?: PluginsViewModel; dispatch: PluginsDispatch }) {
  if (!vm) {
    return <div class="degrade"><span class="codicon codicon-loading" /><div>Loading plugins…</div></div>;
  }

  const wsRuntimes = vm.present.length > 0
    ? vm.present.map((r, i) => <span key={r}>{i > 0 ? " · " : ""}<b>{r}</b></span>)
    : <span class="dim">no runtimes detected</span>;

  return (
    <div>
      <div class="head">
        <div class="wrap">
          <div class="head-row">
            <div>
              <div class="title">🧩 Plugins</div>
              <p class="sub">Browse, install &amp; manage plugins · <span class="ws-rt">this workspace runs {wsRuntimes}</span></p>
            </div>
            <div class="actions">
              <button class="act-btn" title="Refresh" onClick={() => dispatch.refresh()}><Icon name="refresh" /> Refresh</button>
            </div>
          </div>
        </div>
      </div>

      <div class="wrap">
        {vm.parseError && (
          <div class="banner"><Icon name="error" /> Lockfile is corrupt — list suppressed. {vm.parseError}</div>
        )}

        {!vm.parseError && vm.empty && (
          <div class="empty">
            <div class="big">No plugins installed.</div>
            <div>Install one by its git source — <span class="mono">github:owner/repo@ref</span>. <span class="dim">(install-by-source arrives next)</span></div>
          </div>
        )}

        {!vm.parseError && !vm.empty && (
          <div class="list">
            {vm.installed.map((p) => <Card key={p.name} p={p} />)}
          </div>
        )}
      </div>
    </div>
  );
}
