import type { SectionsModel } from "../../sections/model";
import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import { EngineLogPanel } from "../shared/control/EngineLogPanel";
import { Badge, Button, PageChrome } from "../shared/ui";
import type { CockpitStrings } from "../shared/control/messages";
import { POLL, type SystemAction } from "./messages";
import { summariseWorkspaceRows } from "./summary";

export type Strings = Pick<
  CockpitStrings,
  | "systemTitle"
  | "systemHint"
  | "auto"
  | "refresh"
  | "copyDiagnostics"
  | "openDoctor"
  | "workspaces"
  | "workspacesInWindow"
  | "engines"
  | "errors"
  | "agents"
  | "inbox"
  | "worktrees"
  | "empty"
  | "attached"
  | "error"
  | "none"
  | "state"
  | "pid"
  | "version"
  | "instance"
  | "started"
  | "bundle"
  | "protocol"
  | "url"
  | "port"
  | "auth"
  | "root"
  | "hash"
  | "running"
>;

function StateBadge({ s, state }: { s: Strings; state: "attached" | "error" | "none" }) {
  return (
    <Badge tone={state === "attached" ? "ok" : state === "error" ? "err" : "default"}>
      {state === "attached" ? s.attached : state === "error" ? s.error : s.none}
    </Badge>
  );
}

function Kv({ k, v }: { k: string; v?: string | number | null }) {
  return v === undefined || v === null || v === "" ? null : (
    <>
      <span class="k">{k}</span>
      <span class="v">{String(v)}</span>
    </>
  );
}

function Metric({ label, value, tone = "", sub }: { label: string; value: string | number; tone?: string; sub?: string }) {
  return (
    <div class={`ck-metric ${tone}`}>
      <div class="label">{label}</div>
      <div class="value">{value}</div>
      {sub === undefined ? null : <div class="sub">{sub}</div>}
    </div>
  );
}

/**
 * SDD 500 — the rollup, drawn from the very rows below it (`summariseWorkspaceRows`, see summary.ts
 * for why that is the point rather than a detail).
 *
 * The one number that is NOT about the rows is labelled as such. `model.overview.workspaceCount` is the
 * count of workspaces attached to this WINDOW, and it is deliberately unscoped (t-72ff5a: scoping it
 * "would pin it to 1 forever and retire the only number that says a second project exists"). This app
 * is a per-project dashboard, so it draws exactly one card — printing the window's 3 above one card
 * would be precisely the counter-contradicts-the-cards state spec.md forbids. So the VALUE is the rows
 * on screen and the window's count survives underneath, saying its own scope out loud.
 */
function Summary({
  s,
  rows,
  overview,
  post,
}: {
  s: Strings;
  rows: readonly ControlInspectorWorkspaceRow[];
  overview: SectionsModel["overview"];
  post: (a: SystemAction) => void;
}) {
  const derived = summariseWorkspaceRows(rows);
  const window = overview.workspaceCount;
  return (
    <div class="ck-metrics">
      <Metric
        label={s.workspaces}
        value={derived.workspaces}
        sub={window > derived.workspaces ? s.workspacesInWindow.replace("{0}", String(window)) : undefined}
      />
      <Metric label={s.engines} value={derived.enginesAttached} tone={derived.enginesAttached > 0 ? "ok" : ""} />
      <Metric label={s.errors} value={derived.enginesError} tone={derived.enginesError > 0 ? "warn" : ""} />
      <Metric label={s.agents} value={`${derived.agentsRunning}/${derived.agentsTotal}`} />
      <button
        type="button"
        class={`ck-metric ck-metric-btn ${overview.inboxPending > 0 ? "warn" : ""}`}
        onClick={() => post({ type: "openSection", section: "inbox" })}
      >
        <span class="label">{s.inbox}</span>
        <span class="value">{overview.inboxPending}</span>
      </button>
      <Metric label={s.worktrees} value={overview.worktreesActive} />
    </div>
  );
}

function WorkspaceCard({
  s,
  row,
  post,
}: {
  s: Strings;
  row: ControlInspectorWorkspaceRow;
  post: (a: SystemAction) => void;
}) {
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
            <Kv
              k={s.auth}
              v={row.bridge.authConfigured === undefined ? undefined : String(row.bridge.authConfigured)}
            />
          </div>
        </div>
        <div class="ci-card">
          <h3>
            <span class="codicon codicon-folder" /> Workspace
          </h3>
          <div class="ci-kv">
            <Kv k={s.root} v={row.workspaceRoot} />
            <Kv k={s.hash} v={row.wsHash} />
            <Kv
              k={s.agents}
              v={row.agents ? `${row.agents.running}/${row.agents.total} ${s.running}` : undefined}
            />
          </div>
        </div>
      </div>
      <EngineLogPanel row={row} post={post} />
    </section>
  );
}

/**
 * SDD 500 — System: "is Tachyon up and healthy, and if not, where?"
 *
 * The summary answers the first half at a glance and the per-workspace card answers "where" without a
 * second navigation. There is no collapse rule, and its absence is a DECISION rather than an omission
 * (t-7b92bd, 2026-08-09): plan.md § D4 proposed collapsing the detail whenever more than one workspace
 * was on screen, and the measurement that killed it is `model.ts`'s own scoping — `buildSectionsModel`
 * filters bundles to the ONE selected workspace, so `control.workspaces` is 0 or 1 and a second card
 * cannot exist. A rule only a test fixture could reach is machinery with no tap; the owner's ruling was
 * to cancel it outright and write it against a real case if multi-scope ever returns.
 */
export function App({
  model,
  strings: s,
  auto,
  setAuto,
  post,
}: {
  model?: SectionsModel;
  strings: Strings;
  auto: boolean;
  setAuto: (value: boolean) => void;
  post: (a: SystemAction) => void;
}) {
  const rows = model?.control.workspaces ?? [];
  return (
    <main class="ds-page" data-testid="control-system">
      <PageChrome
        title={s.systemTitle}
        hint={s.systemHint}
        actions={
          <div class="ck-system-actions">
            <label class="ck-auto" title={s.auto}>
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto((e.target as HTMLInputElement).checked)}
              />
              {s.auto}
            </label>
            <Button variant="default" icon="refresh" onClick={() => post({ type: POLL })}>
              {s.refresh}
            </Button>
            <Button variant="default" icon="copy" onClick={() => post({ type: "copyDiagnostics" })}>
              {s.copyDiagnostics}
            </Button>
            <Button variant="primary" onClick={() => post({ type: "openDoctor" })}>
              {s.openDoctor}
            </Button>
          </div>
        }
      />
      {model === undefined ? null : <Summary s={s} rows={rows} overview={model.overview} post={post} />}
      {rows.length === 0 ? (
        <div class="ck-empty">{s.empty}</div>
      ) : (
        <div class="ck-card-list">
          {rows.map((row) => (
            <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} post={post} />
          ))}
        </div>
      )}
    </main>
  );
}
