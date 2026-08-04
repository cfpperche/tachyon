import type { CockpitModel } from "../../cockpit/model";
import type { CockpitStrings } from "../cockpit/messages";
import { Button, PageChrome } from "../shared/ui";
import type { OverviewAction } from "./messages";

type Strings = Pick<CockpitStrings, "overviewTitle" | "overviewHint" | "auto" | "refresh" |
  "copyDiagnostics" | "workspaces" | "engines" | "errors" | "agents" | "inbox" | "worktrees" |
  "bridges" | "empty" | "navEngine" | "navFleet" | "navInbox" | "navMission" | "navHandoff" |
  "navRuntime" | "navPlugins" | "navSettings" | "navTmux">;

export function App({ model: m, strings: s, auto, setAuto, post }: {
  model?: CockpitModel; strings: Strings; auto: boolean; setAuto: (value: boolean) => void;
  post: (action: OverviewAction) => void;
}) {
  const o = m?.overview;
  if (!o) return <main><PageChrome title={s.overviewTitle} hint={s.overviewHint} /></main>;
  const open = (section: string) => post({ type: "openSection", section });
  return <main>
    <PageChrome title={s.overviewTitle} hint={s.overviewHint} actions={<div class="ck-overview-actions">
      <label class="ck-auto" title={s.auto}><input type="checkbox" checked={auto}
        onChange={(e) => setAuto((e.target as HTMLInputElement).checked)} />{s.auto}</label>
      <Button variant="default" icon="refresh" onClick={() => post({ type: POLL })}>{s.refresh}</Button>
      <Button variant="default" icon="copy" onClick={() => post({ type: "copyDiagnostics" })}>{s.copyDiagnostics}</Button>
    </div>} />
    <div class="ck-metrics">
      <Metric label={s.workspaces} value={o.workspaceCount} />
      <Metric label={s.engines} value={o.enginesAttached} tone={o.enginesAttached > 0 ? "ok" : ""} />
      <Metric label={s.errors} value={o.enginesError} tone={o.enginesError > 0 ? "warn" : ""} />
      <Metric label={s.agents} value={`${o.agentsRunning}/${o.agentsTotal}`} />
      <button type="button" class={`ck-metric ck-metric-btn ${o.inboxPending > 0 ? "warn" : ""}`}
        onClick={() => open("inbox")}><span class="label">{s.inbox}</span><span class="value">{o.inboxPending}</span></button>
      <Metric label={s.worktrees} value={o.worktreesActive} />
    </div>
    <div class="ck-panel"><h2>{s.bridges}</h2>{o.bridges.length === 0 ? <p class="ck-empty">{s.empty}</p> :
      <ul class="ck-bridge-list">{o.bridges.map((b) => <li key={b.folder + b.url}><span class="name">{b.folder}</span>
        <span>{b.url}</span><span>{b.ok ? "✓" : "!"}</span></li>)}</ul>}</div>
    <div class="ck-panel"><h2>Jump</h2><div class="ck-jump">
      {[["engine", s.navEngine], ["fleet", s.navFleet], ["inbox", s.navInbox], ["mission", s.navMission],
        ["handoff", s.navHandoff], ["runtime", s.navRuntime], ["plugins", s.navPlugins], ["settings", s.navSettings],
        ["tmux", s.navTmux]].map(([section, label]) => <Button variant="default" onClick={() => open(section)}>{label}</Button>)}
      <Button variant="default" onClick={() => post({ type: "openDoctor" })}>Doctor</Button>
    </div></div>
  </main>;
}

function Metric({ label, value, tone = "" }: { label: string; value: string | number; tone?: string }) {
  return <div class={`ck-metric ${tone}`}><div class="label">{label}</div><div class="value">{value}</div></div>;
}
