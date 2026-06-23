import { useState } from "preact/hooks";
import type { InstalledPluginVM, PluginsViewModel, PluginStatus, RuntimePill, PluginAction } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import type { Toast } from "./main";

// spec 250 — the Plugins View (Preact, render-only). Header + install-by-source input + Installed/Marketplace
// tabs; one card per installed plugin (provenance · per-plugin runtime pills · status badge · actions); and the
// BLOCKING consent drawer the host fills from previewInstall/Update/Remove before any write. Never imports
// vscode/engine — only the VM TYPES.

export interface PluginsDispatch {
  refresh(): void;
  checkUpdates(): void;
  install(spec: string): void;
  update(name: string): void;
  reinstall(name: string): void;
  remove(name: string): void;
  confirm(token: string): void;
  cancel(): void;
  dismissToast(): void;
}

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

function statusBadge(status: PluginStatus): { tone: string; label: string } | null {
  switch (status.kind) {
    case "up-to-date": return { tone: "ok", label: "up to date" };
    case "update-available": return { tone: "warn", label: `update available${status.latestVersion ? ` · v${status.latestVersion}` : ""}` };
    case "drift": return { tone: "err", label: "drift · edited locally" };
    case "conflict": return { tone: "err", label: "conflict" };
    case "error": return { tone: "err", label: status.detail ? `error · ${status.detail}` : "error" };
    case "unknown": return null;
  }
}

const actionLabel: Record<PluginAction, string> = { update: "Update", reinstall: "Reinstall", remove: "Remove" };

function RuntimePillView({ pill }: { pill: RuntimePill }) {
  return (
    <span class={pill.present ? "rt has" : "rt miss"} title={pill.present ? "materialized & present" : "materialized for this runtime, but it is no longer in the workspace"}>
      {pill.runtime} {pill.present ? "✓" : "—"}
    </span>
  );
}

function Card({ p, dispatch }: { p: InstalledPluginVM; dispatch: PluginsDispatch }) {
  const badge = statusBadge(p.status);
  const run = (a: PluginAction) => {
    if (a === "update") dispatch.update(p.name);
    else if (a === "reinstall") dispatch.reinstall(p.name);
    else dispatch.remove(p.name);
  };
  return (
    <div class="card">
      <div class="card-top">
        <span class="pname">{p.name}</span>
        <span class="pver">v{p.version}</span>
        {badge && <span class={`badge ${badge.tone}`}>{badge.label}</span>}
        <div class="card-actions">
          {p.actions.map((a) => (
            <button key={a} class={a === "remove" ? "act-btn" : "btn-primary"} onClick={() => run(a)}>{actionLabel[a]}</button>
          ))}
        </div>
      </div>
      <div class="pmeta">
        {p.sourceSpec ? <span class="src">{p.sourceSpec}</span> : <span class="dim">local dir install</span>}
        {p.shortCommit && <><span>·</span><span class="mono dim">{p.shortCommit}</span></>}
        <span>·</span>
        {p.runtimes.map((pill) => <RuntimePillView key={pill.runtime} pill={pill} />)}
      </div>
    </div>
  );
}

function ConsentDrawer({ vm, dispatch }: { vm: ConsentVM; dispatch: PluginsDispatch }) {
  const blocked = (vm.errors?.length ?? 0) > 0;
  return (
    <div class="scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("scrim")) dispatch.cancel(); }}>
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="dhead">
          <span class="ttl">{vm.title}</span>
          <button class="x" onClick={() => dispatch.cancel()} aria-label="cancel">✕</button>
        </div>
        <div class="dbody">
          {vm.errors && vm.errors.map((e) => <div key={e} class="banner"><Icon name="error" /> {e}</div>)}
          {vm.warnings && vm.warnings.map((w) => <div key={w} class="warnline"><Icon name="warning" /> {w}</div>)}

          {vm.provenance && (
            <div class="sec">
              <h3>Provenance</h3>
              <div class="kv">{vm.provenance.map((r) => <><span class="k">{r.k}</span><span class="v">{r.v}</span></>)}</div>
            </div>
          )}

          {vm.runtimes && (
            <div class="sec">
              <h3>Runtimes</h3>
              <div>{vm.runtimes.map((r) => <span key={r.runtime} class={`badge ${r.status === "install" ? "ok" : ""}`}>{r.runtime}{r.status === "skip" ? " — skipped (not present)" : ""}</span>)}</div>
            </div>
          )}

          {vm.wiredCommands && vm.wiredCommands.length > 0 && (
            <div class="sec">
              <h3>Permission summary — these run on agent events</h3>
              <div class="perm">
                {vm.wiredCommands.map((c, i) => <div key={i} class="cmd"><span class="ev">{c.runtime}</span> {c.command}</div>)}
              </div>
            </div>
          )}

          {vm.writes && (
            <div class="sec">
              <h3>File writes</h3>
              <div class="diff">{vm.writes.map((w, i) => <div key={i} class="dl add">{w.file}{w.note ? <span class="dim"> — {w.note}</span> : null}</div>)}</div>
            </div>
          )}

          {vm.conflicts && vm.conflicts.length > 0 && (
            <div class="sec">
              <h3>Conflicts with your edits</h3>
              {vm.conflicts.map((c, i) => <div key={i} class="cmd">{c.settingsRel} — {c.edited} edited, {c.collided} would-duplicate</div>)}
            </div>
          )}

          {vm.removeSummary && (
            <div class="sec">
              <h3>Removal</h3>
              <div class="kv">
                <span class="k">hook groups removed</span><span class="v">{vm.removeSummary.removedCount}</span>
                <span class="k">orphans kept</span><span class="v">{vm.removeSummary.orphans}</span>
              </div>
            </div>
          )}
        </div>
        <div class="dfoot">
          {vm.token && <span class="fp">consent · {vm.token.slice(0, 12)}</span>}
          <button class="act-btn" onClick={() => dispatch.cancel()}>Cancel</button>
          <button class={`btn-primary${vm.requiresForce ? " danger" : ""}`} disabled={blocked} onClick={() => dispatch.confirm(vm.token)}>{vm.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function App({ vm, consent, busy, toast, dispatch }: { vm?: PluginsViewModel; consent?: ConsentVM; busy?: string; toast?: Toast; dispatch: PluginsDispatch }) {
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [spec, setSpec] = useState("");

  if (!vm) {
    return <div class="degrade"><span class="codicon codicon-loading" /><div>Loading plugins…</div></div>;
  }

  const wsRuntimes = vm.present.length > 0
    ? vm.present.map((r, i) => <span key={r}>{i > 0 ? " · " : ""}<b>{r}</b></span>)
    : <span class="dim">no runtimes detected</span>;

  const submitSpec = () => { const s = spec.trim(); if (s) { dispatch.install(s); setSpec(""); } };

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
              <button class="act-btn" title="Check installed plugins for updates" onClick={() => dispatch.checkUpdates()}><Icon name="cloud-download" /> Check updates</button>
              <button class="act-btn" title="Refresh" onClick={() => dispatch.refresh()}><Icon name="refresh" /> Refresh</button>
            </div>
          </div>
          <div class="addbar">
            <input
              value={spec}
              placeholder="github:owner/repo@ref   ·   install a plugin by its git source"
              onInput={(e) => setSpec((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitSpec(); }}
            />
            <button class="btn-primary" disabled={!spec.trim()} onClick={submitSpec}>Add</button>
          </div>
          <div class="tabs">
            <button class={`tab${tab === "installed" ? " active" : ""}`} onClick={() => setTab("installed")}>Installed <span class="count">({vm.installed.length})</span></button>
            <button class={`tab${tab === "market" ? " active" : ""}`} onClick={() => setTab("market")}>Marketplace</button>
          </div>
        </div>
      </div>

      <div class="wrap">
        {tab === "market" ? (
          <div class="empty">
            <div class="big">A curated registry is coming in v2.</div>
            <div>For now, install any plugin by its git source above — <span class="mono">github:owner/repo@ref</span>.</div>
          </div>
        ) : vm.parseError ? (
          <div class="banner"><Icon name="error" /> Lockfile is corrupt — list suppressed. {vm.parseError}</div>
        ) : vm.empty ? (
          <div class="empty">
            <div class="big">No plugins installed.</div>
            <div>Install one by its git source above — <span class="mono">github:owner/repo@ref</span>.</div>
          </div>
        ) : (
          <div class="list">
            {vm.installed.map((p) => <Card key={p.name} p={p} dispatch={dispatch} />)}
          </div>
        )}
      </div>

      {consent && <ConsentDrawer vm={consent} dispatch={dispatch} />}
      {busy && <div class="busy"><span class="codicon codicon-loading" /> {busy}</div>}
      {toast && (
        <div class={`toast ${toast.ok ? "ok" : "err"}`} onClick={() => dispatch.dismissToast()}>
          <Icon name={toast.ok ? "check" : "error"} /> {toast.message}
        </div>
      )}
    </div>
  );
}
