import type { CockpitModel } from "../../cockpit/model";
import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";
import { EngineLogPanel } from "../cockpit/EngineLogPanel";
import { Badge, Button, PageChrome } from "../shared/ui";
import type { CockpitStrings } from "../cockpit/messages";
import type { EngineAction } from "./messages";

export type Strings = Pick<
  CockpitStrings,
  | "engineTitle"
  | "openDoctor"
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
  | "agents"
  | "running"
>;

export const defaultStrings: Strings = {
  engineTitle: "Engine / Bridge",
  openDoctor: "Run Doctor",
  empty: "Nothing to show.",
  attached: "Attached",
  error: "Error",
  none: "None",
  state: "State",
  pid: "PID",
  version: "Version",
  instance: "Instance",
  started: "Started",
  bundle: "Bundle",
  protocol: "Protocol",
  url: "URL",
  port: "Port",
  auth: "Auth",
  root: "Root",
  hash: "Hash",
  agents: "Agents",
  running: "running",
};

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

function WorkspaceCard({
  s,
  row,
  post,
}: {
  s: Strings;
  row: ControlInspectorWorkspaceRow;
  post: (a: EngineAction) => void;
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

export function App({
  model,
  strings: s,
  post,
}: {
  model?: CockpitModel;
  strings: Strings;
  post: (a: EngineAction) => void;
}) {
  return (
    <main class="ds-page">
      <PageChrome
        title={s.engineTitle}
        hint="Control plane per attached workspace."
        actions={
          <Button variant="primary" onClick={() => post({ type: "openDoctor" })}>
            {s.openDoctor}
          </Button>
        }
      />
      {!model || model.control.workspaces.length === 0 ? (
        <div class="ck-empty">{s.empty}</div>
      ) : (
        <div class="ck-card-list" data-testid="control-engine">
          {model.control.workspaces.map((row) => (
            <WorkspaceCard key={row.wsHash + row.workspaceRoot} s={s} row={row} post={post} />
          ))}
        </div>
      )}
    </main>
  );
}
