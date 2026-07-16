import type { ComponentChildren } from "preact";
import {
  COCKPIT_SECTION_ORDER,
  type CockpitModel,
  type CockpitSectionId,
} from "../../cockpit/model";
import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import type { CockpitStrings } from "./messages";
import { Button } from "../shared/ui";

export interface CockpitAppProps {
  model: CockpitModel | undefined;
  strings: CockpitStrings | undefined;
  toast?: string;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onRefresh: () => void;
  onCopyDiagnostics: () => void;
  onOpenServerInspector: () => void;
  onOpenMissionControl: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onOpenApprovals: () => void;
  onOpenRuntimeOps: () => void;
  onOpenDoctor: () => void;
  onSetSection: (section: CockpitSectionId) => void;
}

const TAB_META: Record<CockpitSectionId, { icon: string; navKey: keyof CockpitStrings }> = {
  overview: { icon: "dashboard", navKey: "navOverview" },
  engine: { icon: "server-environment", navKey: "navEngine" },
  fleet: { icon: "organization", navKey: "navFleet" },
  approvals: { icon: "pass", navKey: "navApprovals" },
  mission: { icon: "checklist", navKey: "navMission" },
  worktrees: { icon: "folder-library", navKey: "navWorktrees" },
  deliveries: { icon: "git-commit", navKey: "navDeliveries" },
  runtime: { icon: "graph", navKey: "navRuntime" },
  tmux: { icon: "terminal-tmux", navKey: "navTmux" },
  plugins: { icon: "extensions", navKey: "navPlugins" },
  schedules: { icon: "calendar", navKey: "navSchedules" },
  settings: { icon: "settings-gear", navKey: "navSettings" },
};

function StateBadge({ s, state }: { s: CockpitStrings; state: "attached" | "error" | "none" }) {
  const label = state === "attached" ? s.attached : state === "error" ? s.error : s.none;
  return <span class={`ci-badge ${state}`}>{label}</span>;
}

function Kv({ k, v }: { k: string; v?: string | number | null }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <>
      <span class="k">{k}</span>
      <span class="v">{String(v)}</span>
    </>
  );
}

function WorkspaceCard({ s, row }: { s: CockpitStrings; row: ControlInspectorWorkspaceRow }) {
  return (
    <section class="ci-ws">
      <div class="ci-ws-head">
        <div>
          <div class="name">{row.folderName}</div>
          <div class="meta">{row.wsHash}</div>
        </div>
        <StateBadge s={s} state={row.engine.state} />
      </div>
      <div class="ci-grid">
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-server-environment" /> Engine
          </h3>
          <div class="ci-kv">
            <Kv k={s.state} v={row.engine.state} />
            <Kv k={s.pid} v={row.engine.pid} />
            <Kv k={s.version} v={row.engine.engineVersion} />
            <Kv k={s.instance} v={row.engine.instanceId} />
            <Kv k={s.started} v={row.engine.startedAt} />
            <Kv k={s.bundle} v={row.engine.bundleId} />
            <Kv
              k={s.protocol}
              v={
                row.engine.protocolMin !== undefined && row.engine.protocolMax !== undefined
                  ? `${row.engine.protocolMin}…${row.engine.protocolMax}`
                  : undefined
              }
            />
            <Kv k={s.error} v={row.engine.error} />
          </div>
        </div>
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-plug" /> Bridge
          </h3>
          <div class="ci-kv">
            <Kv k={s.url} v={row.bridge.url} />
            <Kv k={s.port} v={row.bridge.port} />
            <Kv k={s.instance} v={row.bridge.instanceId} />
            <Kv k={s.auth} v={row.bridge.authConfigured === undefined ? undefined : String(row.bridge.authConfigured)} />
          </div>
        </div>
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-folder" /> Workspace
          </h3>
          <div class="ci-kv">
            <Kv k={s.root} v={row.workspaceRoot} />
            <Kv k={s.hash} v={row.wsHash} />
            <Kv k={s.agents} v={row.agents ? `${row.agents.running}/${row.agents.total} ${s.running}` : undefined} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ModuleChrome({
  title,
  hint,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <>
      <div class="ck-head">
        <div>
          <h1>{title}</h1>
          <p class="hint">{hint}</p>
        </div>
        {actionLabel && onAction ? (
          <Button variant="primary" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </>
  );
}

function DataTable({
  headers,
  rows,
  empty,
  monoCols = [],
}: {
  headers: string[];
  rows: string[][];
  empty: string;
  /** Column indexes that are technical (paths, ids) — Tachyon Mono. */
  monoCols?: number[];
}) {
  if (rows.length === 0) return <p class="ck-empty">{empty}</p>;
  const mono = new Set(monoCols);
  return (
    <div class="ck-table-wrap">
      <table class="ck-table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} class={mono.has(j) ? "ck-mono" : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App(p: CockpitAppProps) {
  const s = p.strings;
  if (!s) return <div class="ds-empty" />;
  const m = p.model;
  const section = m?.section ?? "overview";

  let body: ComponentChildren = null;
  if (!m) {
    body = <div class="ck-empty">{s.empty}</div>;
  } else if (section === "overview") {
    const o = m.overview;
    body = (
      <>
        <div class="ck-head">
          <div>
            <h1>
              <span class="codicon codicon-dashboard" />
              {s.overviewTitle}
            </h1>
            <p class="hint">{s.overviewHint}</p>
          </div>
        </div>
        <div class="ck-chips">
          <div class="ck-chip">
            <div class="label">{s.workspaces}</div>
            <div class="value">{o.workspaceCount}</div>
          </div>
          <div class={`ck-chip ${o.enginesAttached > 0 ? "ok" : ""}`}>
            <div class="label">{s.engines}</div>
            <div class="value">{o.enginesAttached}</div>
          </div>
          <div class={`ck-chip ${o.enginesError > 0 ? "warn" : ""}`}>
            <div class="label">{s.errors}</div>
            <div class="value">{o.enginesError}</div>
          </div>
          <div class="ck-chip">
            <div class="label">{s.agents}</div>
            <div class="value">
              {o.agentsRunning}/{o.agentsTotal}
            </div>
          </div>
          <div class={`ck-chip ${o.approvalsPending > 0 ? "warn" : ""}`}>
            <div class="label">{s.approvals}</div>
            <div class="value">{o.approvalsPending}</div>
          </div>
          <div class="ck-chip">
            <div class="label">{s.worktrees}</div>
            <div class="value">{o.worktreesActive}</div>
          </div>
          <div class="ck-chip">
            <div class="label">{s.deliveries}</div>
            <div class="value">{o.deliveriesOpen}</div>
          </div>
        </div>
        <div class="ck-panel">
          <h2>{s.bridges}</h2>
          {o.bridges.length === 0 ? (
            <p class="ck-empty">{s.empty}</p>
          ) : (
            <ul class="ck-bridge-list">
              {o.bridges.map((b) => (
                <li key={b.folder + b.url}>
                  <span class="name">{b.folder}</span>
                  <span>{b.url}</span>
                  <StateBadge s={s} state={b.ok ? "attached" : "error"} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="ck-panel">
          <h2>Jump</h2>
          <div class="ck-actions">
            <Button variant="default" onClick={() => p.onSetSection("engine")}>
              {s.navEngine}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("fleet")}>
              {s.navFleet}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("approvals")}>
              {s.navApprovals}
            </Button>
            <Button variant="default" onClick={p.onOpenMissionControl}>
              {s.navMission}
            </Button>
            <Button variant="default" onClick={p.onOpenRuntimeOps}>
              {s.navRuntime}
            </Button>
            <Button variant="default" onClick={p.onOpenPlugins}>
              {s.navPlugins}
            </Button>
            <Button variant="default" onClick={p.onOpenSettings}>
              {s.navSettings}
            </Button>
            <Button variant="default" onClick={p.onOpenServerInspector}>
              {s.navTmux}
            </Button>
            <Button variant="default" onClick={p.onOpenDoctor}>
              Doctor
            </Button>
          </div>
        </div>
      </>
    );
  } else if (section === "engine") {
    body = (
      <ModuleChrome title={s.engineTitle} hint="Control plane per attached workspace." actionLabel={s.openDoctor} onAction={p.onOpenDoctor}>
        {m.control.workspaces.length === 0 ? (
          <div class="ck-empty">{s.empty}</div>
        ) : (
          m.control.workspaces.map((row) => <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} />)
        )}
      </ModuleChrome>
    );
  } else if (section === "fleet") {
    body = (
      <ModuleChrome title={s.fleetTitle} hint={s.fleetHint} actionLabel={s.openMissionControl} onAction={p.onOpenMissionControl}>
        <DataTable
          headers={[s.name, s.kind, s.status]}
          rows={m.fleet.map((a) => [a.name, a.kind ?? "—", a.running ? s.running : s.stopped])}
          empty={s.noneListed}
        />
        {/* name/kind/status stay on reading font */}
      </ModuleChrome>
    );
  } else if (section === "approvals") {
    body = (
      <ModuleChrome title={s.approvalsTitle} hint={s.approvalsHint} actionLabel={s.openApprovals} onAction={p.onOpenApprovals}>
        <DataTable
          headers={[s.name, s.status]}
          rows={m.approvals.map((a) => [a.title ?? a.id, a.status ?? "pending"])}
          empty={s.noneListed}
        />
      </ModuleChrome>
    );
  } else if (section === "mission") {
    body = (
      <ModuleChrome title={s.missionTitle} hint={s.missionHint} actionLabel={s.openMissionControl} onAction={p.onOpenMissionControl}>
        <div class="ck-panel">
          <p>
            Agents running: {m.overview.agentsRunning}/{m.overview.agentsTotal}. Approvals pending: {m.overview.approvalsPending}.
          </p>
          <p>Open Mission Control for the full work board (drag lanes, task detail).</p>
        </div>
      </ModuleChrome>
    );
  } else if (section === "worktrees") {
    body = (
      <ModuleChrome title={s.worktreesTitle} hint={s.worktreesHint}>
        <DataTable
          headers={[s.kind, s.status, s.branch, s.path]}
          rows={m.worktrees.map((w) => [w.kind, w.status, w.branch || "—", w.path || w.id])}
          empty={s.noneListed}
          monoCols={[2, 3]}
        />
      </ModuleChrome>
    );
  } else if (section === "deliveries") {
    body = (
      <ModuleChrome title={s.deliveriesTitle} hint={s.deliveriesHint}>
        <DataTable
          headers={[s.name, s.phase, s.branch, s.path]}
          rows={m.deliveries.map((d) => [d.id, d.phase, d.branchRef || "—", d.worktreePath ?? "—"])}
          empty={s.noneListed}
          monoCols={[0, 2, 3]}
        />
      </ModuleChrome>
    );
  } else if (section === "runtime") {
    body = (
      <ModuleChrome title={s.runtimeTitle} hint={s.runtimeHint} actionLabel={s.openRuntimeOps} onAction={p.onOpenRuntimeOps}>
        <div class="ck-panel">
          <p>Open Runtime Ops for usage, rate limits, and cost signals. Cockpit does not re-implement that panel.</p>
        </div>
      </ModuleChrome>
    );
  } else if (section === "tmux") {
    body = (
      <ModuleChrome title={s.tmuxTitle} hint={s.tmuxHint} actionLabel={s.openServerInspector} onAction={p.onOpenServerInspector}>
        <DataTable
          headers={[s.name, s.state, s.version]}
          rows={m.tmux.map((t) => [t.folder, t.state, t.version ?? "—"])}
          empty={s.noneListed}
        />
      </ModuleChrome>
    );
  } else if (section === "plugins") {
    body = (
      <ModuleChrome title={s.pluginsTitle} hint={s.pluginsHint} actionLabel={s.openPlugins} onAction={p.onOpenPlugins}>
        <div class="ck-panel">
          <p>Install, update, and integrity live in the Plugins panel.</p>
        </div>
      </ModuleChrome>
    );
  } else if (section === "schedules") {
    body = (
      <ModuleChrome title={s.schedulesTitle} hint={s.schedulesHint}>
        <DataTable
          headers={[s.name, s.status]}
          rows={m.schedules.map((x) => [x.name, x.paused ? "paused" : "active"])}
          empty={s.noneListed}
        />
      </ModuleChrome>
    );
  } else {
    body = (
      <ModuleChrome title={s.settingsTitle} hint={s.settingsHint} actionLabel={s.openSettings} onAction={p.onOpenSettings}>
        <div class="ck-panel">
          <p>Opens Tachyon extension settings in the VS Code Settings UI.</p>
        </div>
      </ModuleChrome>
    );
  }

  return (
    <div class="ck-root">
      <header class="ck-top">
        <div class="ck-top-row">
          <div class="ck-brand">
            <span class="codicon codicon-dashboard" />
            <div>
              <div class="title">{s.title}</div>
              <div class="sub">{s.subtitle}</div>
            </div>
          </div>
          <div class="ck-actions">
            <label class="ck-auto">
              <input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />
              {s.auto}
            </label>
            <Button variant="default" onClick={p.onRefresh}>
              <span class="codicon codicon-refresh" /> {s.refresh}
            </Button>
            <Button variant="default" onClick={p.onCopyDiagnostics}>
              <span class="codicon codicon-copy" /> {s.copyDiagnostics}
            </Button>
          </div>
        </div>
        <div class="ck-tabs" role="tablist" aria-label={s.title}>
          {COCKPIT_SECTION_ORDER.map((id) => {
            const meta = TAB_META[id];
            return (
              <button
                type="button"
                role="tab"
                key={id}
                aria-selected={section === id}
                class={section === id ? "active" : ""}
                onClick={() => p.onSetSection(id)}
              >
                <span class={`codicon codicon-${meta.icon}`} />
                {s[meta.navKey]}
              </button>
            );
          })}
        </div>
        <p class="ck-note">{s.sidebarNote}</p>
      </header>

      <main class="ck-main">
        <div class="ck-banner">{s.pocBanner}</div>
        {body}
        {m ? (
          <div class="ck-checked">
            {s.checkedAt}: {m.checkedAt}
          </div>
        ) : null}
      </main>

      {p.toast ? <div class="ck-toast">{p.toast}</div> : null}
    </div>
  );
}
