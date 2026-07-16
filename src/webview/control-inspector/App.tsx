import type { ControlInspectorModel, ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import type { ControlInspectorStrings } from "./messages";
import { Button } from "../shared/ui";

export interface ControlInspectorAppProps {
  model: ControlInspectorModel | undefined;
  strings: ControlInspectorStrings | undefined;
  toast?: string;
  auto: boolean;
  onToggleAuto: (on: boolean) => void;
  onRefresh: () => void;
  onCopyDiagnostics: () => void;
  onOpenServerInspector: () => void;
}

function StateBadge({ s, state }: { s: ControlInspectorStrings; state: "attached" | "error" | "none" }) {
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

function WorkspaceCard({ s, row }: { s: ControlInspectorStrings; row: ControlInspectorWorkspaceRow }) {
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
          <h3><span class="codicon codicon-server-environment" />{s.engine}</h3>
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
          <h3><span class="codicon codicon-plug" />{s.bridge}</h3>
          <div class="ci-kv">
            <Kv k={s.url} v={row.bridge.url} />
            <Kv k={s.port} v={row.bridge.port} />
            <Kv k={s.instance} v={row.bridge.instanceId} />
            <Kv k={s.auth} v={row.bridge.authConfigured === undefined ? undefined : String(row.bridge.authConfigured)} />
          </div>
        </div>
        <div class="ci-card">
          <h3><span class="codicon codicon-folder" />{s.workspace}</h3>
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

export function App(p: ControlInspectorAppProps) {
  const s = p.strings;
  if (!s) return <div class="ds-empty" />;

  const m = p.model;

  return (
    <div class="ci-root">
      <div class="ci-head">
        <div>
          <h2 class="ds-title">
            <span class="codicon codicon-debug-console" />
            {s.title}
          </h2>
          <p class="ci-sub">{s.subtitle}</p>
        </div>
        <div class="ci-actions">
          <label class="ds-check" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={p.auto} onChange={(e) => p.onToggleAuto((e.target as HTMLInputElement).checked)} />
            {s.auto}
          </label>
          <Button variant="default" onClick={p.onRefresh}>
            <span class="codicon codicon-refresh" /> {s.refresh}
          </Button>
          <Button variant="default" onClick={p.onCopyDiagnostics}>
            <span class="codicon codicon-copy" /> {s.copyDiagnostics}
          </Button>
          <Button variant="default" onClick={p.onOpenServerInspector}>
            <span class="codicon codicon-terminal-tmux" /> {s.openServerInspector}
          </Button>
        </div>
      </div>

      <div class="ci-banner">{s.pocBanner}</div>

      {!m ? (
        <div class="ci-empty">{s.empty}</div>
      ) : (
        <>
          <div class="ci-summary" aria-label={s.summary}>
            <div class="ci-stat">
              <div class="label">{s.workspaces}</div>
              <div class="value">{m.summary.workspaceCount}</div>
            </div>
            <div class="ci-stat">
              <div class="label">{s.attached}</div>
              <div class="value">{m.summary.attachedEngines}</div>
            </div>
            <div class="ci-stat">
              <div class="label">{s.error}</div>
              <div class="value">{m.summary.engineErrors}</div>
            </div>
            <div class="ci-stat">
              <div class="label">{s.agents}</div>
              <div class="value">
                {m.summary.runningAgents}/{m.summary.totalAgents}
              </div>
            </div>
          </div>

          {m.workspaces.length === 0 ? (
            <div class="ci-empty">{s.empty}</div>
          ) : (
            m.workspaces.map((row) => <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} />)
          )}

          <div class="ci-checked">
            {s.checkedAt}: {m.checkedAt}
          </div>
        </>
      )}

      {p.toast ? <div class="ci-toast">{p.toast}</div> : null}
    </div>
  );
}
