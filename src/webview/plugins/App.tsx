import { useState } from "preact/hooks";
import type { InstalledPluginVM, PluginsViewModel, PluginStatus, RuntimePill, PluginAction } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import type { Toast } from "./main";

// spec 250 — the Plugins View (Preact, render-only). Header + install-by-source input + Installed/Marketplace
// tabs; one card per installed plugin (provenance · per-plugin runtime pills · status badge · actions); and the
// BLOCKING consent drawer the host fills from previewInstall/Update/Remove before any write. Never imports
// vscode/engine — only the VM TYPES.
// spec 252 — styled by the shared design system: .ds-* classes (title/sub/badge/btn/card/tabs/input/empty/…)
// come from design-system.css; only genuinely panel-specific bits (cards meta, runtime pills, consent drawer,
// busy/toast) keep bespoke classes, all referencing --ds-* tokens.

export interface PluginsDispatch {
  refresh(): void;
  checkUpdates(): void;
  install(spec: string): void;
  update(name: string): void;
  reinstall(name: string): void;
  remove(name: string): void;
  /** spec 263 — re-preview the pending install for a new runtime selection (host-owned recompute on each toggle). */
  reselect(runtimes: string[]): void;
  /** spec 264 — re-claim core.hooksPath after a clone whose managed git-hook state is intact but inactive. */
  repair(): void;
  /** spec 265 — re-provision tools from the lockfile after a clone (the gitignored `.tachyon/bin` is absent). */
  rehydrate(): void;
  confirm(token: string, skillDecisions?: Record<string, "keep" | "replace">, mcpDecisions?: Record<string, "keep" | "replace">, mcpConfirmed?: boolean, gitHookConfirmed?: boolean, toolConfirmed?: boolean): void;
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
    <span class={pill.present ? "rt has" : "rt miss"} title={pill.present ? "installed into this runtime — materialization present on disk" : "installed into this runtime, but its materialized files are missing (drift)"}>
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
    <div class="ds-card">
      <div class="card-top">
        <span class="pname">{p.name}</span>
        <span class="pver">v{p.version}</span>
        {badge && <span class={`ds-badge ${badge.tone}`}>{badge.label}</span>}
        <div class="card-actions">
          {p.actions.map((a) => (
            <button key={a} class={a === "remove" ? "ds-btn" : "ds-btn-primary"} onClick={() => run(a)}>{actionLabel[a]}</button>
          ))}
        </div>
      </div>
      <div class="pmeta">
        {p.sourceSpec ? <span class="src">{p.sourceSpec}</span> : <span class="ds-dim">local dir install</span>}
        {p.shortCommit && <><span>·</span><span class="ds-mono ds-dim">{p.shortCommit}</span></>}
        <span>·</span>
        {p.runtimes.map((pill) => <RuntimePillView key={pill.runtime} pill={pill} />)}
      </div>
    </div>
  );
}

function ConsentDrawer({ vm, dispatch }: { vm: ConsentVM; dispatch: PluginsDispatch }) {
  const collisions = vm.skillCollisions ?? [];
  const mcpCollisions = vm.mcpCollisions ?? [];
  // each colliding skill dest defaults to the SAFE choice (Keep); Replace is opt-in + double-confirmed.
  const [decisions, setDecisions] = useState<Record<string, "keep" | "replace">>(() => Object.fromEntries(collisions.map((c) => [c.destRel, "keep" as const])));
  const [mcpDecisions, setMcpDecisions] = useState<Record<string, "keep" | "replace">>(() => Object.fromEntries(mcpCollisions.map((c) => [c.key, "keep" as const])));
  const [replaceAck, setReplaceAck] = useState(false);
  const [mcpAck, setMcpAck] = useState(false);
  const [gitHookAck, setGitHookAck] = useState(false);
  const [toolAck, setToolAck] = useState(false);
  const anyReplace = Object.values(decisions).some((d) => d === "replace");
  const anyMcpReplace = Object.values(mcpDecisions).some((d) => d === "replace");
  // spec 263 — install lets the user pick which declared runtimes to materialize (host re-previews on each
  // toggle). Deselecting ALL of them disables confirm (never a payload-only no-op).
  const isInstall = vm.op === "install";
  const runtimeRows = vm.runtimes ?? [];
  const selectedRuntimes = runtimeRows.filter((r) => r.selected).map((r) => r.runtime);
  const toggleRuntime = (rt: string) =>
    dispatch.reselect(selectedRuntimes.includes(rt) ? selectedRuntimes.filter((r) => r !== rt) : [...selectedRuntimes, rt]);
  const noRuntimeSelected = isInstall && runtimeRows.length > 0 && selectedRuntimes.length === 0;
  // OQ5: ANY MCP install needs the second confirmation (not just Replace) — agent-invokable process/network.
  const blocked = (vm.errors?.length ?? 0) > 0 || noRuntimeSelected || (anyReplace && !replaceAck) || (!!vm.requiresMcpConfirm && !mcpAck) || (!!vm.requiresGitHookConfirm && !gitHookAck) || (!!vm.requiresToolConfirm && !toolAck);
  const setDecision = (dest: string, d: "keep" | "replace") => setDecisions((m) => ({ ...m, [dest]: d }));
  const setMcpDecision = (key: string, d: "keep" | "replace") => setMcpDecisions((m) => ({ ...m, [key]: d }));
  return (
    <div class="scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("scrim")) dispatch.cancel(); }}>
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="dhead">
          <span class="ttl">{vm.title}</span>
          <button class="x" onClick={() => dispatch.cancel()} aria-label="cancel">✕</button>
        </div>
        <div class="dbody">
          {vm.errors && vm.errors.map((e) => <div key={e} class="ds-banner"><Icon name="error" /> {e}</div>)}
          {vm.warnings && vm.warnings.map((w) => <div key={w} class="warnline"><Icon name="warning" /> {w}</div>)}

          {vm.provenance && (
            <div class="sec">
              <h3>Provenance</h3>
              <div class="kv">{vm.provenance.map((r) => <><span class="k">{r.k}</span><span class="v">{r.v}</span></>)}</div>
            </div>
          )}

          {runtimeRows.length > 0 && (
            <div class="sec">
              <h3>Runtimes — {isInstall ? "choose where to install" : "materialized into"}</h3>
              {isInstall ? (
                <div class="rtsel">
                  {runtimeRows.map((r) => (
                    <label key={r.runtime} class={`rtrow${r.selected ? " on" : ""}`}>
                      <input type="checkbox" checked={r.selected} onChange={() => toggleRuntime(r.runtime)} />
                      <span class="rtname">{r.runtime}</span>
                      <span class="ds-dim">{r.present ? "present" : "will be created"}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <div>{runtimeRows.map((r) => <span key={r.runtime} class="ds-badge ok">{r.runtime} <span class="ds-dim">· {r.present ? "present" : "will be created"}</span></span>)}</div>
              )}
              {noRuntimeSelected && <div class="warnline"><Icon name="warning" /> Select at least one runtime to install into.</div>}
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
              <div class="diff">{vm.writes.map((w, i) => <div key={i} class="dl add">{w.file}{w.note ? <span class="ds-dim"> — {w.note}</span> : null}</div>)}</div>
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
                {vm.removeSummary.skillCount > 0 && <><span class="k">skills removed</span><span class="v">{vm.removeSummary.skillCount}</span></>}
                {vm.removeSummary.mcpCount > 0 && <><span class="k">MCP servers removed</span><span class="v">{vm.removeSummary.mcpCount}</span></>}
                {vm.removeSummary.gitHookCount > 0 && <><span class="k">git-hooks removed</span><span class="v">{vm.removeSummary.gitHookCount}</span></>}
                {vm.removeSummary.removedCount > 0 && <><span class="k">hook groups removed</span><span class="v">{vm.removeSummary.removedCount}</span></>}
                <span class="k">orphans kept</span><span class="v">{vm.removeSummary.orphans}</span>
              </div>
              <div class="ds-dim" style="margin-top:6px">The plugin's committed payload and any empty directories this install created are also removed.</div>
            </div>
          )}

          {vm.skills && vm.skills.length > 0 && (
            <div class="sec">
              <h3>Skills</h3>
              {vm.skills.map((s) => <div key={s.name} class="cmd"><span class="ev">{s.runtimes.join(", ")}</span> {s.name}</div>)}
            </div>
          )}

          {collisions.length > 0 && (
            <div class="sec">
              <h3>Skill collisions — you already have these skills</h3>
              {collisions.map((c) => (
                <div key={c.destRel} class="collrow">
                  <span class="ds-mono">{c.destRel}</span>
                  <div class="seg">
                    <button class={decisions[c.destRel] === "keep" ? "seg-on" : ""} onClick={() => setDecision(c.destRel, "keep")}>Keep mine</button>
                    <button class={decisions[c.destRel] === "replace" ? "seg-on seg-danger" : ""} onClick={() => setDecision(c.destRel, "replace")}>Replace</button>
                  </div>
                </div>
              ))}
              {anyReplace && (
                <label class="ackline">
                  <input type="checkbox" checked={replaceAck} onChange={(e) => setReplaceAck((e.target as HTMLInputElement).checked)} />
                  <span><Icon name="warning" /> I understand <b>Replace</b> permanently overwrites my existing skill — there is no undo.</span>
                </label>
              )}
            </div>
          )}

          {vm.mcp && vm.mcp.length > 0 && (
            <div class="sec">
              <h3>MCP servers — these become tools the agent can invoke</h3>
              {vm.mcp.map((s) => (
                <div key={s.name} class="cmd">
                  <span class="ev">{s.runtimes.join(", ")}</span> <b>{s.name}</b> <span class="ds-dim">({s.transport})</span> {s.detail}
                  {s.env.length > 0 && <div class="ds-dim">needs env: {s.env.join(", ")}</div>}
                </div>
              ))}
            </div>
          )}

          {mcpCollisions.length > 0 && (
            <div class="sec">
              <h3>MCP collisions — you already have these servers</h3>
              {mcpCollisions.map((c) => (
                <div key={c.key} class="collrow">
                  <span class="ds-mono">{c.server} <span class="ds-dim">({c.runtime})</span></span>
                  <div class="seg">
                    <button class={mcpDecisions[c.key] === "keep" ? "seg-on" : ""} onClick={() => setMcpDecision(c.key, "keep")}>Keep mine</button>
                    <button class={mcpDecisions[c.key] === "replace" ? "seg-on seg-danger" : ""} onClick={() => setMcpDecision(c.key, "replace")}>Replace</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {vm.requiresMcpConfirm && (
            <label class="ackline">
              <input type="checkbox" checked={mcpAck} onChange={(e) => setMcpAck((e.target as HTMLInputElement).checked)} />
              <span><Icon name="warning" /> I understand these <b>MCP servers</b> become tools the agent can run on its own (local processes / network calls){anyMcpReplace ? ", and Replace permanently overwrites my existing server" : ""}.</span>
            </label>
          )}

          {vm.gitHooks && vm.gitHooks.length > 0 && (
            <div class="sec">
              <h3>Git hooks — these run on EVERY commit, for everyone</h3>
              {vm.gitHooks.map((g) => (
                <div key={g.event} class="cmd">
                  <span class="ev">{g.event}</span> {g.command}
                  {g.chainsPrior && <div class="ds-dim">your existing {g.event} hook runs first, then this</div>}
                </div>
              ))}
              <div class="ds-dim" style="margin-top:6px">Runs for you, the agent, and your IDE at commit time; it can read staged content and block the commit. <span class="ds-mono">git commit --no-verify</span> bypasses it. Removing the plugin restores your prior hook setup.</div>
            </div>
          )}

          {vm.requiresGitHookConfirm && (
            <label class="ackline">
              <input type="checkbox" checked={gitHookAck} onChange={(e) => setGitHookAck((e.target as HTMLInputElement).checked)} />
              <span><Icon name="warning" /> I understand this installs a <b>git hook</b> that runs on every commit — for me, the agent, and my IDE — and can block commits.</span>
            </label>
          )}

          {vm.tools && vm.tools.length > 0 && (
            <div class="sec">
              <h3>Tools — Tachyon will DOWNLOAD and EXECUTE these binaries</h3>
              {vm.tools.map((t) => (
                <div key={t.name} class="cmd">
                  <span class="ev">{t.name}@{t.version}</span> <span class="ds-dim">{t.platform}</span>
                  <div class="ds-mono" style="font-size:11px;word-break:break-all">{t.declaredUrl}</div>
                  {t.finalUrl !== t.declaredUrl && <div class="ds-dim ds-mono" style="font-size:11px;word-break:break-all">→ {t.finalUrl}</div>}
                  <div class="ds-dim ds-mono" style="font-size:11px">sha256 {t.sha256.slice(0, 16)}… · publisher {t.publisher}</div>
                  {t.launchPolicy && (
                    <div class="ds-dim" style="font-size:11px;margin-top:4px">
                      <Icon name="warning" /> Always launches with{" "}
                      {t.launchPolicy.env && <span class="ds-mono">env {Object.entries(t.launchPolicy.env).map(([k, v]) => `${k}=${v}`).join(" ")}</span>}
                      {t.launchPolicy.args && <span class="ds-mono"> args {t.launchPolicy.args.join(" ")}</span>}
                      {t.launchPolicy.denyArgs && <span> · refuses <span class="ds-mono">{t.launchPolicy.denyArgs.join(" ")}</span></span>}
                      {" "}(enforced by the Tachyon launcher).
                    </div>
                  )}
                </div>
              ))}
              <div class="ds-dim" style="margin-top:6px">The <span class="ds-mono">sha256</span> proves the bytes match the plugin's manifest — it does <b>not</b> vouch for the publisher. Verify you trust <b>{vm.tools.map((t) => t.publisher).filter((p, i, a) => a.indexOf(p) === i).join(", ")}</b>. The binary is installed read-only + content-addressed under <span class="ds-mono">.tachyon/bin</span> and re-validated before every run.</div>
            </div>
          )}

          {vm.requiresToolConfirm && (
            <label class="ackline">
              <input type="checkbox" checked={toolAck} onChange={(e) => setToolAck((e.target as HTMLInputElement).checked)} />
              <span><Icon name="warning" /> I understand Tachyon will <b>download and execute</b> the binaries above, and that the checksum proves integrity against the manifest, <b>not</b> publisher trust.</span>
            </label>
          )}
        </div>
        <div class="dfoot">
          {vm.token && <span class="fp">consent · {vm.token.slice(0, 12)}</span>}
          <button class="ds-btn" onClick={() => dispatch.cancel()}>Cancel</button>
          <button class={`ds-btn-primary${vm.requiresForce || anyReplace || anyMcpReplace || vm.requiresGitHookConfirm || vm.requiresToolConfirm ? " ds-danger" : ""}`} disabled={blocked} onClick={() => dispatch.confirm(vm.token, decisions, mcpDecisions, mcpAck, gitHookAck, toolAck)}>{vm.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function App({ vm, consent, busy, toast, dispatch }: { vm?: PluginsViewModel; consent?: ConsentVM; busy?: string; toast?: Toast; dispatch: PluginsDispatch }) {
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [spec, setSpec] = useState("");

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading plugins…</div></div>;
  }

  const wsRuntimes = vm.present.length > 0
    ? vm.present.map((r, i) => <span key={r}>{i > 0 ? " · " : ""}<b>{r}</b></span>)
    : <span class="ds-dim">no runtimes detected</span>;

  const submitSpec = () => { const s = spec.trim(); if (s) { dispatch.install(s); setSpec(""); } };

  return (
    <div>
      <div class="ds-head">
        <div class="ds-wrap">
          <div class="ds-head-row">
            <div>
              <div class="ds-title">🧩 Plugins</div>
              <p class="ds-sub">Browse, install &amp; manage plugins · <span class="ws-rt">this workspace runs {wsRuntimes}</span></p>
            </div>
            <div class="ds-actions">
              <button class="ds-btn" title="Check installed plugins for updates" onClick={() => dispatch.checkUpdates()}><Icon name="cloud-download" /> Check updates</button>
              <button class="ds-btn" title="Re-activate git-hooks after a clone (re-claim core.hooksPath)" onClick={() => dispatch.repair()}><Icon name="wrench" /> Repair hooks</button>
              <button class="ds-btn" title="Refresh" onClick={() => dispatch.refresh()}><Icon name="refresh" /> Refresh</button>
            </div>
          </div>
          <div class="addbar">
            <input
              class="ds-input"
              value={spec}
              placeholder="github:owner/repo@ref   ·   install a plugin by its git source"
              onInput={(e) => setSpec((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitSpec(); }}
            />
            <button class="ds-btn-primary" disabled={!spec.trim()} onClick={submitSpec}>Add</button>
          </div>
          <div class="ds-tabs">
            <button class={`ds-tab${tab === "installed" ? " active" : ""}`} onClick={() => setTab("installed")}>Installed <span class="count">({vm.installed.length})</span></button>
            <button class={`ds-tab${tab === "market" ? " active" : ""}`} onClick={() => setTab("market")}>Marketplace</button>
          </div>
        </div>
      </div>

      <div class="ds-wrap">
        {tab === "market" ? (
          <div class="ds-empty">
            <div class="ds-big">A curated registry is coming in v2.</div>
            <div>For now, install any plugin by its git source above — <span class="ds-mono">github:owner/repo@ref</span>.</div>
          </div>
        ) : vm.parseError ? (
          <div class="ds-banner"><Icon name="error" /> Lockfile is corrupt — list suppressed. {vm.parseError}</div>
        ) : vm.empty ? (
          <div class="ds-empty">
            <div class="ds-big">No plugins installed.</div>
            <div>Install one by its git source above — <span class="ds-mono">github:owner/repo@ref</span>.</div>
          </div>
        ) : (
          <div class="list">
            {vm.installed.map((p) => <Card key={p.name} p={p} dispatch={dispatch} />)}
          </div>
        )}
      </div>

      {/* key by consent identity so a new consent REMOUNTS with fresh Keep/Replace state (no stale Replace+ack leak). */}
      {consent && <ConsentDrawer key={consent.token} vm={consent} dispatch={dispatch} />}
      {busy && <div class="busy"><span class="codicon codicon-loading" /> {busy}</div>}
      {toast && (
        <div class={`toast ${toast.ok ? "ok" : "err"}`} onClick={() => dispatch.dismissToast()}>
          <Icon name={toast.ok ? "check" : "error"} /> {toast.message}
        </div>
      )}
    </div>
  );
}
