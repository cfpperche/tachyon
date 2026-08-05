import { useMemo, useState } from "preact/hooks";
import type { InstalledPluginVM, PluginsViewModel, PluginStatus, RuntimePill, PluginAction } from "../../plugins/viewModel";
import type { Runtime } from "../../plugins/manifest";
import type { ConsentVM } from "../../plugins/consentViewModel";
import type { ConfirmPayload } from "./messages";
import { isConsentBlocked, viewAckRequirements, viewConsentRows } from "./consentViewAcks";
import { Button, IconButton, Tabs, Badge, PageChrome, EmptyState, Input } from "../shared/ui";
import { KitSelect, KitDropdown, KitDropdownTrigger, KitDropdownContent, KitDropdownItem } from "../shared/ui/kit";
import { filterAndSortInstalledPlugins, type InstalledSortMode } from "./listControls";

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
  checkPluginUpdate(name: string): void;
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
  confirm(payload: ConfirmPayload): void;
  /** spec 285 drawer path (no pluginName); spec 287 installed-card path passes the plugin so the host resolves the
   *  requirement from the LOCKFILE rather than a pending consent op. */
  installExternal(externalTool: string, pluginName?: string): void;
  cancel(): void;
  dismissToast(): void;
  /** spec 270 — open the plugin's human-owned config file in an editor (Config button). */
  openConfig(name: string): void;
  /** spec 270 — open the plugin's docs URL externally (Docs button). */
  openDocs(name: string): void;
}

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

function statusBadge(status: PluginStatus): { tone: string; label: string } | null {
  switch (status.kind) {
    case "up-to-date": return { tone: "ok", label: "up to date" };
    case "update-available": return { tone: "warn", label: `update available${status.latestVersion ? ` · v${status.latestVersion}` : ""}` };
    // t-4e5f11 — true about the version AND the world: same label, different source bytes.
    case "source-changed": return { tone: "warn", label: `source changed · ${status.detail ?? "content differs"}` };
    case "drift": return { tone: "err", label: "drift · edited locally" };
    case "conflict": return { tone: "err", label: "conflict" };
    case "error": return { tone: "err", label: status.detail ? `error · ${status.detail}` : "error" };
    case "unknown": return null;
  }
}

const actionLabel: Record<PluginAction, string> = { update: "Update", reapply: "Reapply", reinstall: "Reinstall", remove: "Remove" };

function RuntimePillView({ pill }: { pill: RuntimePill }) {
  return (
    <span class={pill.present ? "rt has" : "rt miss"} title={pill.present ? "installed into this runtime — materialization present on disk" : "installed into this runtime, but its materialized files are missing (drift)"}>
      {pill.runtime} {pill.present ? "✓" : "—"}
    </span>
  );
}

/** "grok" / "grok and codex" / "grok, codex and claude" — the uncovered runtimes as a readable list. */
function runtimeList(rts: Runtime[]): string {
  return rts.length <= 1 ? rts.join("") : `${rts.slice(0, -1).join(", ")} and ${rts[rts.length - 1]}`;
}

/**
 * t-fb216a — the RUNTIME-COVERAGE NOTICE. Names one fact the panel could not previously say: this workspace runs a
 * runtime that the plugin supports and the install never covered. Until now the card's only vocabulary was the
 * lockfile's own runtimes, so the gap was literally unrenderable — and for an enforcement-class plugin that silence
 * means an agent starts with no gate and nobody is told.
 *
 * The copy states the COST of the gesture it points at, because the gesture prescribed before this change (remove,
 * then install by source) drops the gate for the runtimes that DO have it during the window. Reinstall (t-8a062b)
 * does not: it re-materializes the lockfile's recorded commit for every runtime the payload declares, going through
 * the same blocking consent drawer, and never removes first — so saying "claude and codex stay installed" is a
 * measured claim, not reassurance. A plugin with no recorded source has no Reinstall item in the ⋮ menu, so it is
 * pointed at the install door it actually has.
 */
function CoverageNotice({ p }: { p: InstalledPluginVM }) {
  const rts = p.uncoveredRuntimes ?? [];
  if (rts.length === 0) return null;
  const list = runtimeList(rts);
  const them = rts.length === 1 ? "it" : "them";
  const covered = p.runtimes.map((pill) => pill.runtime);
  return (
    <div class="pgap">
      <Badge tone="warn"><Icon name="warning" /> not installed for {list}</Badge>{" "}
      <span>
        This workspace runs <b>{list}</b> and <b>{p.name}</b> supports {them}, but this install never covered {them}.
        {" "}
        {p.sourceSpec
          ? <>Use <b>Reinstall</b> in this card's ⋮ menu — it re-materializes the recorded commit for every runtime the plugin supports, through the same consent drawer.</>
          : <>Install it again from its source directory with {list} selected, through the same consent drawer.</>}
        {covered.length > 0 && <> It never removes first, so {runtimeList(covered)} stay{covered.length === 1 ? "s" : ""} installed throughout.</>}
      </span>
    </div>
  );
}

function Card({ p, dispatch }: { p: InstalledPluginVM; dispatch: PluginsDispatch }) {
  const badge = statusBadge(p.status);
  const run = (a: PluginAction) => {
    // reapply uses the same host update path (previewUpdateOp) — only the label/consent framing differs.
    if (a === "update" || a === "reapply") dispatch.update(p.name);
    else if (a === "reinstall") dispatch.reinstall(p.name);
    else dispatch.remove(p.name);
  };
  // spec 342 Pilot A — the secondary/conditional actions (Reinstall/Check/Docs/Config) collapse into a KitDropdown
  // overflow menu; the primary status action (Update/Reinstall/Remove) stays a direct, visible Button —
  // unchanged dispatch calls either way, just a less cluttered card header for plugins with several
  // conditional actions.
  const hasSecondaryActions = !!(p.sourceSpec || p.docsUrl || p.config);
  return (
    <div class="ds-card">
      <div class="card-top">
        <span class="pname">{p.name}</span>
        <span class="pver">v{p.version}</span>
        {badge && <Badge tone={badge.tone === "ok" || badge.tone === "warn" || badge.tone === "err" || badge.tone === "info" ? badge.tone : "default"}>{badge.label}</Badge>}
        <div class="card-actions">
          {p.actions.map((a) => (
            <Button key={a} variant={a === "remove" ? "default" : "primary"} onClick={() => run(a)}>{actionLabel[a]}</Button>
          ))}
          {hasSecondaryActions && (
            <KitDropdown>
              <KitDropdownTrigger asChild>
                <IconButton name="kebab-vertical" title={`More actions for ${p.name}`} />
              </KitDropdownTrigger>
              <KitDropdownContent align="end">
                {p.sourceSpec && <KitDropdownItem onSelect={() => dispatch.reinstall(p.name)}>Reinstall</KitDropdownItem>}
                {p.sourceSpec && <KitDropdownItem onSelect={() => dispatch.checkPluginUpdate(p.name)}>Check for updates</KitDropdownItem>}
                {p.docsUrl && <KitDropdownItem onSelect={() => dispatch.openDocs(p.name)}>Docs</KitDropdownItem>}
                {p.config && <KitDropdownItem onSelect={() => dispatch.openConfig(p.name)}>Config</KitDropdownItem>}
              </KitDropdownContent>
            </KitDropdown>
          )}
        </div>
      </div>
      <div class="pmeta">
        {p.sourceSpec ? <span class="src">{p.sourceSpec}</span> : <span class="ds-dim">local dir install</span>}
        {p.shortCommit && <><span>·</span><span class="ds-mono ds-dim">{p.shortCommit}</span></>}
        <span>·</span>
        {p.runtimes.map((pill) => <RuntimePillView key={pill.runtime} pill={pill} />)}
      </div>
      <CoverageNotice p={p} />
      {p.externalTools && p.externalTools.length > 0 && (
        // spec 287 — surface declared system tools (present/missing) + a persistent assisted-install affordance for a
        // missing one, so the user can resolve it WITHOUT re-opening the consent drawer. The plugin stays installed
        // either way; a skill needing a missing tool fails closed at runtime.
        <div class="pext">
          {p.externalTools.map((e) => (
            <div key={e.name} class="ext-row">
              <span class="ev">{e.name}</span>{" "}
              {e.present
                ? <Badge tone="ok"><Icon name="check" /> installed</Badge>
                : <Badge tone="warn"><Icon name="warning" /> missing</Badge>}
              {/* spec 289 — disclose which host binaries satisfy this requirement + which one resolved */}
              {e.names && e.names.length > 1 && <span class="ds-dim" style="font-size:11px;margin-left:6px">any of: {e.names.join(" / ")}</span>}
              {e.present && e.resolvedPath && <span class="ds-dim ds-mono" style="font-size:11px;margin-left:6px">{e.resolvedPath}</span>}
              {!e.present && e.installable && (
                <Button icon="terminal" style="margin-left:6px" onClick={() => dispatch.installExternal(e.name, p.name)}>Install in terminal</Button>
              )}
              {!e.present && !e.installable && <span class="ds-dim" style="font-size:11px;margin-left:6px">Manual: {e.manual}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ViewConsentSection({ vm }: { vm: ConsentVM }) {
  const rows = viewConsentRows(vm);
  if (rows.length === 0) return null;
  return (
    <div class="sec">
      <h3>Views — these draw UI inside Tachyon</h3>
      {rows.map((v) => (
        <div key={v.id} class="cmd">
          <span class="ev">{v.surface}</span> <b>{v.title}</b> <span class="ds-dim">({v.id})</span>
          <div class="ds-dim ds-mono" style="font-size:11px;word-break:break-all">{v.entry}</div>
          <div class="ds-dim" style="font-size:11px">{v.disclosure}</div>
          {v.actions.length > 0 && (
            <div class="ds-dim" style="font-size:11px;margin-top:4px">
              actions: {v.actions.map((a) => `${a.name} — ${a.disclosure}`).join("; ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ViewAckLines({
  vm,
  viewAck,
  fleetReadAck,
  actionAck,
  setViewAck,
  setFleetReadAck,
  setActionConfirmed,
}: {
  vm: ConsentVM;
  viewAck: boolean;
  fleetReadAck: boolean;
  actionAck: Record<string, boolean>;
  setViewAck(checked: boolean): void;
  setFleetReadAck(checked: boolean): void;
  setActionConfirmed(key: string, checked: boolean): void;
}) {
  const requiredActionConfirm = Object.fromEntries(viewAckRequirements(vm).filter((r) => r.key !== "view" && r.key !== "fleetRead").map((r) => [r.key, r.label]));
  return (
    <>
      {vm.requiresViewConfirm && (
        <label class="ackline">
          <input type="checkbox" checked={viewAck} onChange={(e) => setViewAck((e.target as HTMLInputElement).checked)} />
          <span><Icon name="warning" /> I understand these <b>views</b> draw UI inside Tachyon and can show information in my editor.</span>
        </label>
      )}

      {vm.requiresFleetReadConfirm && (
        <label class="ackline">
          <input type="checkbox" checked={fleetReadAck} onChange={(e) => setFleetReadAck((e.target as HTMLInputElement).checked)} />
          <span><Icon name="eye" /> I understand these views can read a curated, name-free <b>fleet summary</b>.</span>
        </label>
      )}

      {Object.entries(requiredActionConfirm).map(([key, copy]) => (
        <label key={key} class="ackline">
          <input type="checkbox" checked={actionAck[key] === true} onChange={(e) => setActionConfirmed(key, (e.target as HTMLInputElement).checked)} />
          <span><Icon name="warning" /> I understand action <b>{key}</b>: {copy}</span>
        </label>
      ))}
    </>
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
  const [dataAck, setDataAck] = useState(false);
  const [viewAck, setViewAck] = useState(false);
  const [fleetReadAck, setFleetReadAck] = useState(false);
  const [actionAck, setActionAck] = useState<Record<string, boolean>>({});
  const anyReplace = Object.values(decisions).some((d) => d === "replace");
  const anyMcpReplace = Object.values(mcpDecisions).some((d) => d === "replace");
  // spec 263 — install lets the user pick which declared runtimes to materialize (host re-previews on each
  // toggle). Deselecting ALL of them disables confirm (never a payload-only no-op).
  const isInstall = vm.op === "install";
  const runtimeRows = vm.runtimes ?? [];
  const selectedRuntimes = runtimeRows.filter((r) => r.selected).map((r) => r.runtime);
  const toggleRuntime = (rt: Runtime) =>
    dispatch.reselect(selectedRuntimes.includes(rt) ? selectedRuntimes.filter((r) => r !== rt) : [...selectedRuntimes, rt]);
  const noRuntimeSelected = isInstall && runtimeRows.length > 0 && selectedRuntimes.length === 0;
  // OQ5: ANY MCP install needs the second confirmation (not just Replace) — agent-invokable process/network.
  const blocked = isConsentBlocked(vm, { noRuntimeSelected, anyReplace, replaceAck, mcpAck, gitHookAck, toolAck, dataAck, viewAck, fleetReadAck, actionAck });
  const setDecision = (dest: string, d: "keep" | "replace") => setDecisions((m) => ({ ...m, [dest]: d }));
  const setMcpDecision = (key: string, d: "keep" | "replace") => setMcpDecisions((m) => ({ ...m, [key]: d }));
  const setActionConfirmed = (key: string, checked: boolean) => setActionAck((m) => ({ ...m, [key]: checked }));
  const confirm = () => dispatch.confirm({
    token: vm.token,
    skillDecisions: decisions,
    mcpDecisions,
    mcpConfirmed: mcpAck,
    gitHookConfirmed: gitHookAck,
    toolConfirmed: toolAck,
    dataConfirmed: dataAck,
    viewConfirmed: viewAck,
    fleetReadConfirmed: fleetReadAck,
    actionConfirmed: actionAck,
  });
  return (
    <div class="scrim" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("scrim")) dispatch.cancel(); }}>
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="dhead">
          <span class="ttl">{vm.title}</span>
          <IconButton name="close" title="cancel" onClick={() => dispatch.cancel()} />
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

          {vm.requires && vm.requires.length > 0 && (
            <div class="sec">
              <h3>Requires — declared by the plugin (install separately; may not work until present)</h3>
              {vm.requires.map((d) => {
                const ok = d.status === "satisfied";
                return (
                  <div key={d.name} class="kv">
                    <span class="k">{ok ? "✓" : "⚠"} {d.name}</span>
                    <span class="v">
                      {d.status === "satisfied" && `installed ${d.installedVersion} — satisfies ${d.range}`}
                      {d.status === "missing" && `not installed — wants ${d.range}`}
                      {d.status === "out-of-range" && `installed ${d.installedVersion} — does NOT satisfy ${d.range}`}
                    </span>
                  </div>
                );
              })}
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

          {vm.settingsHooks && vm.settingsHooks.length > 0 && (
            <div class="sec">
              <h3>Runtime settings hooks — these can intercept agent tool calls</h3>
              {vm.settingsHooks.map((hook) => (
                <div key={`${hook.runtime}:${hook.event}`} class="cmd">
                  <span class="ev">{hook.runtime}</span> <b>{hook.event}</b>{" "}
                  <span class="ds-dim">({hook.matchers.length > 0 ? hook.matchers.join(", ") : "all tools"})</span>
                </div>
              ))}
              <div class="ds-dim" style="margin-top:6px">
                This package registers these hooks in the selected runtime settings. Tachyon-managed agent sessions receive them only when this workspace classifies <b>{vm.pluginName}</b> as <span class="ds-mono">enforcement</span> under <span class="ds-mono">settings.agentHookProjection</span>; an unclassified plugin projects nothing.
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
                    <Button class={decisions[c.destRel] === "keep" ? "seg-on" : ""} onClick={() => setDecision(c.destRel, "keep")}>Keep mine</Button>
                    <Button class={decisions[c.destRel] === "replace" ? "seg-on seg-danger" : ""} onClick={() => setDecision(c.destRel, "replace")}>Replace</Button>
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
                    <Button class={mcpDecisions[c.key] === "keep" ? "seg-on" : ""} onClick={() => setMcpDecision(c.key, "keep")}>Keep mine</Button>
                    <Button class={mcpDecisions[c.key] === "replace" ? "seg-on seg-danger" : ""} onClick={() => setMcpDecision(c.key, "replace")}>Replace</Button>
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

          <ViewConsentSection vm={vm} />
          <ViewAckLines vm={vm} viewAck={viewAck} fleetReadAck={fleetReadAck} actionAck={actionAck} setViewAck={setViewAck} setFleetReadAck={setFleetReadAck} setActionConfirmed={setActionConfirmed} />

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

          {vm.data && vm.data.length > 0 && (
            <div class="sec">
              <h3>Data — Tachyon will DOWNLOAD and STORE these files (never executed)</h3>
              {vm.data.map((d) => (
                <div key={d.name} class="cmd">
                  <span class="ev">{d.name}@{d.version}</span> <span class="ds-dim">{d.platform}</span>
                  <div class="ds-mono" style="font-size:11px;word-break:break-all">{d.declaredUrl}</div>
                  {d.finalUrl !== d.declaredUrl && <div class="ds-dim ds-mono" style="font-size:11px;word-break:break-all">→ {d.finalUrl}</div>}
                  <div class="ds-dim ds-mono" style="font-size:11px">sha256 {d.sha256.slice(0, 16)}… · publisher {d.publisher}</div>
                </div>
              ))}
              <div class="ds-dim" style="margin-top:6px">A pinned, checksummed DATA file (e.g. model weights) installed read-only + content-addressed under <span class="ds-mono">.tachyon/data</span>. It is <b>never executed</b> — a tool reads it via the <span class="ds-mono">_tachyon-data</span> resolver.</div>
            </div>
          )}

          {vm.requiresDataConfirm && (
            <label class="ackline">
              <input type="checkbox" checked={dataAck} onChange={(e) => setDataAck((e.target as HTMLInputElement).checked)} />
              <span><Icon name="database" /> I understand Tachyon will <b>download and store</b> the data files above (read-only, never executed), and the checksum proves integrity against the manifest.</span>
            </label>
          )}

          {vm.externalTools && vm.externalTools.length > 0 && (
            <div class="sec">
              <h3>External tools — required on your system (Tachyon does NOT provide these)</h3>
              {vm.externalTools.map((e) => (
                <div key={e.name} class="cmd">
                  <span class="ev">{e.name}</span>{" "}
                  {e.present ? <span class="ds-badge ok"><Icon name="check" /> installed</span> : <span class="ds-badge warn"><Icon name="warning" /> missing</span>}
                  {/* spec 289 — disclose the candidate binaries that satisfy this requirement + which resolved */}
                  {e.names && e.names.length > 1 && <div class="ds-dim" style="font-size:11px;margin-top:3px">any of: {e.names.join(" / ")}</div>}
                  {e.present && e.resolvedPath && <div class="ds-dim ds-mono" style="font-size:11px;margin-top:3px">{e.resolvedPath}</div>}
                  {!e.present && e.install && (
                    <>
                      <div class="ds-dim ds-mono" style="font-size:11px;margin-top:3px">{e.install.join(" ")}</div>
                      <Button icon="terminal" style="margin-top:4px" onClick={() => dispatch.installExternal(e.name)}>Install in terminal</Button>
                    </>
                  )}
                  {!e.present && !e.install && <div class="ds-dim" style="font-size:11px;margin-top:3px">Manual: {e.manual}</div>}
                </div>
              ))}
              <div class="ds-dim" style="margin-top:6px">An assisted install runs your system package manager in a visible terminal where your OS prompts for your password — Tachyon never sees it. The plugin installs regardless; a skill needing a missing tool fails closed at runtime.</div>
            </div>
          )}
        </div>
        <div class="dfoot">
          {vm.token && <span class="fp">consent · {vm.token.slice(0, 12)}</span>}
          <Button onClick={() => dispatch.cancel()}>Cancel</Button>
          <Button variant={vm.requiresForce || anyReplace || anyMcpReplace || vm.requiresGitHookConfirm || vm.requiresViewConfirm || vm.requiresToolConfirm ? "danger" : "primary"} disabled={blocked} onClick={confirm}>{vm.confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function App({ vm, consent, busy, dispatch }: { vm?: PluginsViewModel; consent?: ConsentVM; busy?: string; dispatch: PluginsDispatch }) {
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [spec, setSpec] = useState("");
  const [filter, setFilter] = useState("");
  const [sortMode, setSortMode] = useState<InstalledSortMode>("name-asc");

  if (!vm) {
    return <div class="ck-plugins-root ds-page"><EmptyState kind="loading" message="Loading plugins…" /></div>;
  }

  const wsRuntimes = vm.present.length > 0
    ? vm.present.map((r, i) => <span key={r}>{i > 0 ? " · " : ""}<b>{r}</b></span>)
    : <span class="ds-dim">no runtimes detected</span>;

  const submitSpec = () => { const s = spec.trim(); if (s) { dispatch.install(s); setSpec(""); } };
  const visibleInstalled = useMemo(() => filterAndSortInstalledPlugins(vm.installed, filter, sortMode), [vm.installed, filter, sortMode]);
  const showInstalledToolbar = tab === "installed" && !vm.parseError && !vm.empty;

  return (
    <div class="ck-plugins-root ds-page">
      <PageChrome
        class="plugins-chrome"
        title="Plugins"
        hint={<span>Browse, install &amp; manage plugins · <span class="ws-rt">this workspace runs {wsRuntimes}</span></span>}
        actions={
          <>
            <Button icon="cloud-download" title="Check installed plugins for updates" onClick={() => dispatch.checkUpdates()}>Check updates</Button>
            <Button icon="wrench" title="Re-activate git-hooks after a clone (re-claim core.hooksPath)" onClick={() => dispatch.repair()}>Repair hooks</Button>
            <Button icon="refresh" title="Refresh" onClick={() => dispatch.refresh()}>Refresh</Button>
          </>
        }
      />
      <div class="addbar">
        <Input
          value={spec}
          placeholder="github:owner/repo@ref   ·   install a plugin by its git source"
          onInput={(e) => setSpec((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitSpec(); }}
        />
        <Button variant="primary" disabled={!spec.trim()} onClick={submitSpec}>Add</Button>
      </div>
      <Tabs
        items={[
          { id: "installed", label: "Installed", count: vm.installed.length },
          { id: "market", label: "Marketplace" },
        ]}
        active={tab}
        onSelect={(id) => setTab(id as "installed" | "market")}
      />
      <div class="plugins-body">
        {showInstalledToolbar && (
          <div class="installed-toolbar" role="region" aria-label="Installed plugins controls">
            <Input
              class="plugin-filter"
              value={filter}
              placeholder="Filter installed plugins..."
              aria-label="Filter installed plugins"
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            {/* spec 342 Pilot A — the ONE Kit swap in this surface: the days-old native <select> here becomes
               KitSelect (defaults to the T3 gate-passed Radix Select; TACHYON_KIT_SELECT=legacy at build
               time restores this exact native <select> with zero call-site change — see notes.md). */}
            <KitSelect
              class="plugin-sort"
              value={sortMode}
              aria-label="Sort installed plugins"
              onValueChange={(v) => setSortMode(v as InstalledSortMode)}
              options={[
                { value: "name-asc", label: "Name A-Z" },
                { value: "name-desc", label: "Name Z-A" },
                { value: "status", label: "Status" },
                { value: "version", label: "Version" },
              ]}
            />
            <span class="toolbar-count">{visibleInstalled.length} / {vm.installed.length}</span>
          </div>
        )}
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
            {visibleInstalled.length > 0
              ? visibleInstalled.map((p) => <Card key={p.name} p={p} dispatch={dispatch} />)
              : (
                <div class="ds-empty filtered-empty">
                  <div class="ds-big">No installed plugins match.</div>
                  <div>Clear the filter or try another search term.</div>
                </div>
              )}
          </div>
        )}
      </div>

      {/* key by consent identity so a new consent REMOUNTS with fresh Keep/Replace state (no stale Replace+ack leak). */}
      {consent && <ConsentDrawer key={consent.token} vm={consent} dispatch={dispatch} />}
      {busy && <div class="busy"><span class="codicon codicon-loading" /> {busy}</div>}
      {/* t-963b66 — result feedback uses product ToastHost (shell); no local .toast slot. */}
    </div>
  );
}
