import type { ComponentChildren } from "preact";
import {
  COCKPIT_SECTION_ORDER,
  type CockpitModel,
  type CockpitSectionId,
} from "../../cockpit/model";
import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import type { CockpitStrings } from "./messages";
import { Button } from "../shared/ui";
import { App as MissionControlApp, type MissionControlDispatch, type TaskErrorEvent } from "../mission-control/App";
import type { MissionControlVM } from "../mission-control/messages";
import { App as ValidationsApp, type ValidationsDispatch } from "../validations/App";
import type { ValidationsViewModel } from "../validations/viewModel";
import { App as ApprovalsApp, type ApprovalDispatch } from "../approval/App";
import type { ApprovalViewModel } from "../approval/viewModel";
import { App as RuntimeOpsApp } from "../runtime-ops/App";
import type { RuntimeOpsProviderV2, RuntimeOpsSnapshot } from "../../runtimeOps/types";
import { App as InspectorApp, type InspectorAppProps } from "../inspector/App";
import { App as PluginsApp, type PluginsDispatch } from "../plugins/App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import type { Toast as PluginsToast } from "../plugins/main";

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
  onFleetStart: (name: string, wsHash?: string) => void;
  onFleetStop: (name: string, wsHash?: string) => void;
  onFleetTerminal: (name: string, wsHash?: string) => void;
  onFleetActivity: (name: string, wsHash?: string) => void;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onOpenConfigFile: (wsHash?: string) => void;
  /** Embedded Mission Control board (same Preact App as the standalone panel). */
  missionVm?: MissionControlVM;
  missionError?: TaskErrorEvent;
  missionDispatch: MissionControlDispatch;
  /** Embedded product surfaces (not Task/Pin/form studios). */
  approvalVm?: ApprovalViewModel;
  approvalError?: string;
  approvalDispatch: ApprovalDispatch;
  validationsVm?: ValidationsViewModel;
  validationsError?: string;
  validationsDispatch: ValidationsDispatch;
  runtimeSnapshot?: RuntimeOpsSnapshot;
  onRuntimeSetProviderObservation: (provider: RuntimeOpsProviderV2, enabled: boolean) => void;
  inspector: Pick<
    InspectorAppProps,
    "model" | "strings" | "captures" | "open" | "auto" | "onToggleAuto" | "onToggleCapture" | "onCloseCapture" | "onAction"
  >;
  pluginsVm?: PluginsViewModel;
  pluginsConsent?: ConsentVM;
  pluginsBusy?: string;
  pluginsToast?: PluginsToast;
  pluginsDispatch: PluginsDispatch;
}

/** Tabs that host a full product surface (no ModuleChrome table / deep-link stub). */
const EMBED_SECTIONS = new Set<CockpitSectionId>(["mission", "validations", "approvals", "runtime", "tmux", "plugins"]);

const TAB_META: Record<CockpitSectionId, { icon: string; navKey: keyof CockpitStrings }> = {
  overview: { icon: "dashboard", navKey: "navOverview" },
  engine: { icon: "server-environment", navKey: "navEngine" },
  fleet: { icon: "organization", navKey: "navFleet" },
  approvals: { icon: "pass", navKey: "navApprovals" },
  mission: { icon: "checklist", navKey: "navMission" },
  validations: { icon: "checklist", navKey: "navValidations" },
  worktrees: { icon: "folder-library", navKey: "navWorktrees" },
  deliveries: { icon: "git-commit", navKey: "navDeliveries" },
  runtime: { icon: "graph", navKey: "navRuntime" },
  tmux: { icon: "terminal-tmux", navKey: "navTmux" },
  plugins: { icon: "extensions", navKey: "navPlugins" },
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
            <Kv
              k={s.version}
              v={[row.engine.engineVersion, row.engine.channel].filter(Boolean).join(" · ") || undefined}
            />
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
      {/* Full-width log — was cramped inside the Engine column; V1.1–V2 add Copy/Clear/filter/source
          toggles into ci-log-actions, kept as an empty slot here. */}
      <div class="ci-log">
        <div class="ci-log-toolbar">
          <div class="ci-log-label">Recent log</div>
          <div class="ci-log-actions" />
        </div>
        {row.engine.logTail && row.engine.logTail.length > 0 ? (
          <pre class="ci-log-pre" aria-label="Recent engine log">{row.engine.logTail.join("\n")}</pre>
        ) : (
          <div class="ci-log-empty">No recent engine log.</div>
        )}
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
          {/* Shell actions live on Overview only — tabs stay a clean navigation strip. */}
          <div class="ck-overview-actions">
            <label class="ck-auto" title={s.auto}>
              <input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />
              {s.auto}
            </label>
            <Button variant="default" onClick={p.onRefresh} title={s.refresh}>
              <span class="codicon codicon-refresh" /> {s.refresh}
            </Button>
            <Button variant="default" onClick={p.onCopyDiagnostics} title={s.copyDiagnostics}>
              <span class="codicon codicon-copy" /> {s.copyDiagnostics}
            </Button>
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
          <div class="ck-jump">
            <Button variant="default" onClick={() => p.onSetSection("engine")}>
              {s.navEngine}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("fleet")}>
              {s.navFleet}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("approvals")}>
              {s.navApprovals}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("mission")}>
              {s.navMission}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("validations")}>
              {s.navValidations}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("runtime")}>
              {s.navRuntime}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("plugins")}>
              {s.navPlugins}
            </Button>
            <Button variant="default" onClick={p.onOpenSettings}>
              {s.navSettings}
            </Button>
            <Button variant="default" onClick={() => p.onSetSection("tmux")}>
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
      <ModuleChrome title={s.fleetTitle} hint={s.fleetHint} actionLabel={s.openMissionControl} onAction={() => p.onSetSection("mission")}>
        {m.fleet.length === 0 ? (
          <p class="ck-empty">{s.noneListed}</p>
        ) : (
          <div class="ck-card-list" data-testid="control-fleet">
            {m.fleet.map((a) => (
              <article key={`${a.wsHash ?? ""}:${a.name}`} class="ck-entity-card">
                <div class="ck-entity-main">
                  <div class="ck-entity-title">
                    <span class="name">{a.name}</span>
                    <span class={`ci-badge ${a.running ? "attached" : "none"}`}>{a.running ? s.running : s.stopped}</span>
                    {a.declared === false ? <span class="ck-pill">{s.adhoc}</span> : <span class="ck-pill muted">{s.declared}</span>}
                    {a.kind ? <span class="ck-pill muted">{a.kind}</span> : null}
                  </div>
                  <div class="ck-entity-meta">
                    {a.folder ? <span>{a.folder}</span> : null}
                    {a.wsHash ? <span class="ck-mono">{a.wsHash.slice(0, 8)}</span> : null}
                  </div>
                </div>
                <div class="ck-entity-actions">
                  {a.running ? (
                    <Button variant="default" onClick={() => p.onFleetStop(a.name, a.wsHash)}>
                      {s.stop}
                    </Button>
                  ) : (
                    <Button variant="default" onClick={() => p.onFleetStart(a.name, a.wsHash)}>
                      {s.start}
                    </Button>
                  )}
                  <Button variant="default" onClick={() => p.onFleetTerminal(a.name, a.wsHash)}>
                    {s.openTerminal}
                  </Button>
                  <Button variant="default" onClick={() => p.onFleetActivity(a.name, a.wsHash)}>
                    {s.openActivity}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </ModuleChrome>
    );
  } else if (section === "approvals") {
    body = (
      <div class="ck-embed-host" data-testid="control-approvals">
        <ApprovalsApp vm={p.approvalVm} error={p.approvalError} dispatch={p.approvalDispatch} />
      </div>
    );
  } else if (section === "mission") {
    // Visual monolith POC: full Mission Control board in-tab (same App + host actions as standalone).
    // t-b87bfe: Validations live on the dedicated Control → Validations tab (not on the task board).
    body = (
      <div class="ck-embed-host ck-mission-host" data-testid="control-mission-board">
        <MissionControlApp vm={p.missionVm} lastError={p.missionError} dispatch={p.missionDispatch} />
      </div>
    );
  } else if (section === "validations") {
    body = (
      <div class="ck-embed-host" data-testid="control-validations-host">
        <ValidationsApp vm={p.validationsVm} error={p.validationsError} dispatch={p.validationsDispatch} />
      </div>
    );
  } else if (section === "worktrees") {
    body = (
      <ModuleChrome title={s.worktreesTitle} hint={s.worktreesHint}>
        {m.worktrees.length === 0 ? (
          <p class="ck-empty">{s.noneListed}</p>
        ) : (
          <div class="ck-card-list" data-testid="control-worktrees">
            {m.worktrees.map((w) => (
              <article key={w.id} class="ck-entity-card">
                <div class="ck-entity-main">
                  <div class="ck-entity-title">
                    <span class="name">{w.slug || w.id}</span>
                    <span class={`ci-badge ${w.status === "active" ? "attached" : "none"}`}>{w.status}</span>
                    <span class="ck-pill muted">{w.kind === "agent" ? s.agent : w.kind === "change" ? s.change : w.kind}</span>
                  </div>
                  <div class="ck-entity-meta">
                    {w.branch ? <span>{s.branch}: <span class="ck-mono">{w.branch}</span></span> : null}
                    {w.agent ? <span>{s.agent}: {w.agent}</span> : null}
                    {w.folder ? <span>{w.folder}</span> : null}
                  </div>
                  {w.path ? <div class="ck-entity-path ck-mono">{w.path}</div> : null}
                </div>
                <div class="ck-entity-actions">
                  {w.path ? (
                    <>
                      <Button variant="default" onClick={() => p.onRevealPath(w.path)}>
                        {s.reveal}
                      </Button>
                      <Button variant="default" onClick={() => p.onCopyText(w.path)}>
                        {s.copyPath}
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </ModuleChrome>
    );
  } else if (section === "deliveries") {
    body = (
      <ModuleChrome title={s.deliveriesTitle} hint={s.deliveriesHint}>
        {m.deliveries.length === 0 ? (
          <p class="ck-empty">{s.noneListed}</p>
        ) : (
          <div class="ck-card-list" data-testid="control-deliveries">
            {m.deliveries.map((d) => (
              <article key={d.id} class="ck-entity-card">
                <div class="ck-entity-main">
                  <div class="ck-entity-title">
                    <span class="name ck-mono">{d.id}</span>
                    <span class={`ci-badge ${["pruned", "abandoned"].includes(d.phase) ? "none" : "attached"}`}>{d.phase}</span>
                  </div>
                  <div class="ck-entity-meta">
                    {d.branchRef ? <span>{s.branch}: <span class="ck-mono">{d.branchRef}</span></span> : null}
                    {d.agent ? <span>{s.agent}: {d.agent}</span> : null}
                    {d.folder ? <span>{d.folder}</span> : null}
                  </div>
                  {d.worktreePath ? <div class="ck-entity-path ck-mono">{d.worktreePath}</div> : null}
                </div>
                <div class="ck-entity-actions">
                  <Button variant="default" onClick={() => p.onCopyText(d.id)}>
                    {s.copyId}
                  </Button>
                  {d.worktreePath ? (
                    <>
                      <Button variant="default" onClick={() => p.onRevealPath(d.worktreePath!)}>
                        {s.reveal}
                      </Button>
                      <Button variant="default" onClick={() => p.onCopyText(d.worktreePath!)}>
                        {s.copyPath}
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </ModuleChrome>
    );
  } else if (section === "runtime") {
    body = (
      <div class="ck-embed-host" data-testid="control-runtime-ops">
        <RuntimeOpsApp snapshot={p.runtimeSnapshot} onSetProviderObservation={p.onRuntimeSetProviderObservation} />
      </div>
    );
  } else if (section === "tmux") {
    body = (
      <div class="ck-embed-host" data-testid="control-tmux-inspector">
        <InspectorApp {...p.inspector} />
      </div>
    );
  } else if (section === "plugins") {
    body = (
      <div class="ck-embed-host" data-testid="control-plugins">
        <div class="ck-plugins-root">
          <PluginsApp
            vm={p.pluginsVm}
            consent={p.pluginsConsent}
            busy={p.pluginsBusy}
            toast={p.pluginsToast}
            dispatch={p.pluginsDispatch}
          />
        </div>
      </div>
    );
  } else {
    // settings (and any unknown section fallback)
    body = (
      <ModuleChrome title={s.settingsTitle} hint={s.settingsHint}>
        <div class="ck-panel" data-testid="control-settings">
          <p>{s.settingsBody}</p>
          <div class="ck-jump">
            <Button variant="default" onClick={p.onOpenSettings}>
              {s.settingsOpenTachyon}
            </Button>
            <Button variant="default" onClick={() => p.onOpenConfigFile(m.control.workspaces[0]?.wsHash)}>
              {s.settingsOpenConfig}
            </Button>
            <Button variant="default" onClick={p.onOpenDoctor}>
              {s.settingsDoctor}
            </Button>
          </div>
        </div>
      </ModuleChrome>
    );
  }

  return (
    <div class="ck-root">
      <header class="ck-top">
        {/* Tabs only — Refresh / Auto / Diagnostics live on Overview. */}
        <div class="ck-chrome">
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
        </div>
      </header>

      <main class={`ck-main${EMBED_SECTIONS.has(section) ? " ck-main--embed" : ""}${section === "mission" ? " ck-main--mission" : ""}`}>
        {body}
        {m && !EMBED_SECTIONS.has(section) ? (
          <div class="ck-checked">
            {s.checkedAt}: {m.checkedAt}
          </div>
        ) : null}
      </main>

      {p.toast ? <div class="ck-toast">{p.toast}</div> : null}
    </div>
  );
}
