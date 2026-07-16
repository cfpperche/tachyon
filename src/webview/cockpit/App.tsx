import type { ComponentChildren } from "preact";
import type { CockpitModel, CockpitSectionId } from "../../cockpit/model";
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
  onSetSection: (section: CockpitSectionId) => void;
}

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
      {row.notes.length > 0 && (
        <ul class="ci-notes">
          {row.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OverviewBody({
  s,
  m,
  onEngine,
  onTmux,
  onMc,
  onPlugins,
  onSettings,
}: {
  s: CockpitStrings;
  m: CockpitModel;
  onEngine: () => void;
  onTmux: () => void;
  onMc: () => void;
  onPlugins: () => void;
  onSettings: () => void;
}) {
  const o = m.overview;
  return (
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
        <h2>Shortcuts</h2>
        <p>Deep-links to existing surfaces — Cockpit does not replace them or the VS Code sidebar.</p>
        <div class="ck-actions">
          <Button variant="default" onClick={onEngine}>
            <span class="codicon codicon-server-environment" /> {s.navEngine}
          </Button>
          <Button variant="default" onClick={onMc}>
            <span class="codicon codicon-checklist" /> {s.navMission}
          </Button>
          <Button variant="default" onClick={onPlugins}>
            <span class="codicon codicon-extensions" /> {s.navPlugins}
          </Button>
          <Button variant="default" onClick={onSettings}>
            <span class="codicon codicon-settings-gear" /> {s.navSettings}
          </Button>
          <Button variant="default" onClick={onTmux}>
            <span class="codicon codicon-terminal-tmux" /> {s.navTmux}
          </Button>
        </div>
      </div>
    </>
  );
}

function Placeholder({ title, body, actionLabel, onAction }: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <>
      <div class="ck-head">
        <div>
          <h1>{title}</h1>
          <p class="hint">{body}</p>
        </div>
      </div>
      <div class="ck-panel">
        <p>{body}</p>
        {actionLabel && onAction ? (
          <Button variant="primary" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** Horizontal top chrome only — no left rail (would confuse with VS Code sidebar). */
export function App(p: CockpitAppProps) {
  const s = p.strings;
  if (!s) return <div class="ds-empty" />;
  const m = p.model;
  const section = m?.section ?? "overview";

  const tabs: Array<{ id: CockpitSectionId; label: string; icon: string; soon?: boolean }> = [
    { id: "overview", label: s.navOverview, icon: "dashboard" },
    { id: "engine", label: s.navEngine, icon: "server-environment" },
    { id: "fleet", label: s.navFleet, icon: "organization", soon: true },
    { id: "tmux", label: s.navTmux, icon: "terminal-tmux", soon: true },
    { id: "mission", label: s.navMission, icon: "checklist", soon: true },
    { id: "plugins", label: s.navPlugins, icon: "extensions", soon: true },
    { id: "settings", label: s.navSettings, icon: "settings-gear", soon: true },
  ];

  let body: ComponentChildren = null;
  if (!m) {
    body = <div class="ck-empty">{s.empty}</div>;
  } else if (section === "overview") {
    body = (
      <OverviewBody
        s={s}
        m={m}
        onEngine={() => p.onSetSection("engine")}
        onTmux={p.onOpenServerInspector}
        onMc={p.onOpenMissionControl}
        onPlugins={p.onOpenPlugins}
        onSettings={p.onOpenSettings}
      />
    );
  } else if (section === "engine") {
    body = (
      <>
        <div class="ck-head">
          <div>
            <h1>
              <span class="codicon codicon-server-environment" />
              {s.engineTitle}
            </h1>
            <p class="hint">Control plane per attached workspace engine.</p>
          </div>
        </div>
        {m.control.workspaces.length === 0 ? (
          <div class="ck-empty">{s.empty}</div>
        ) : (
          m.control.workspaces.map((row) => (
            <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} />
          ))
        )}
      </>
    );
  } else if (section === "fleet") {
    body = (
      <Placeholder title={s.fleetTitle} body={s.fleetBody} actionLabel={s.openMissionControl} onAction={p.onOpenMissionControl} />
    );
  } else if (section === "tmux") {
    body = (
      <Placeholder title={s.tmuxTitle} body={s.tmuxBody} actionLabel={s.openServerInspector} onAction={p.onOpenServerInspector} />
    );
  } else if (section === "mission") {
    body = (
      <Placeholder title={s.missionTitle} body={s.missionBody} actionLabel={s.openMissionControl} onAction={p.onOpenMissionControl} />
    );
  } else if (section === "plugins") {
    body = (
      <Placeholder title={s.pluginsTitle} body={s.pluginsBody} actionLabel={s.openPlugins} onAction={p.onOpenPlugins} />
    );
  } else {
    body = (
      <Placeholder title={s.settingsTitle} body={s.settingsBody} actionLabel={s.openSettings} onAction={p.onOpenSettings} />
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
          {tabs.map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab.id}
              aria-selected={section === tab.id}
              class={section === tab.id ? "active" : ""}
              onClick={() => p.onSetSection(tab.id)}
            >
              <span class={`codicon codicon-${tab.icon}`} />
              {tab.label}
              {tab.soon ? <span class="tag">{s.soon}</span> : null}
            </button>
          ))}
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
