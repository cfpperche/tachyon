import { useEffect, useState } from "preact/hooks";
import { Button, Badge, EmptyState, PageChrome } from "../shared/ui";
import {
  KitDropdown,
  KitDropdownContent,
  KitDropdownItem,
  KitDropdownTrigger,
} from "../shared/ui/kit";
import { RuntimeLogo } from "../agent-studio-shell/runtimeLogos";
import type {
  RuntimeConfigChange,
  RuntimeConfigControlSnapshot,
  RuntimeConfigRuntime,
} from "../../runtimeConfig/types";
import type { RuntimeConfigStrings } from "./messages";

/**
 * SDD 485 D8 — the Runtime Config renderer moved whole from Control. It consumes only `rcp-` classes
 * from runtime-config.css: no shared Control stylesheet is needed.
 */
export function App({
  s,
  snapshot,
  unavailable,
  onOpenSource,
  onSaveChanges,
}: {
  s: RuntimeConfigStrings;
  snapshot?: RuntimeConfigControlSnapshot;
  unavailable?: boolean;
  onOpenSource: (path: string) => void;
  onSaveChanges: (runtime: RuntimeConfigRuntime, documentId: string, expectedRevision: string | undefined, changes: RuntimeConfigChange[]) => void;
}) {
  const runtimeLabel = (id: RuntimeConfigRuntime) => ({
    claude: s.runtimeConfigClaude,
    codex: s.runtimeConfigCodex,
    grok: s.runtimeConfigGrok,
  } as Record<string, string>)[id] ?? id;
  const documentLabel = (id: string) => ({
    "codex-global": s.runtimeConfigGlobalConfig,
    "codex-workspace": s.runtimeConfigWorkspaceConfig,
    "claude-global-settings": s.runtimeConfigGlobalSettings,
    "claude-workspace-settings": s.runtimeConfigWorkspaceSettings,
    "claude-workspace-mcp": s.runtimeConfigWorkspaceMcp,
    "grok-global-config": s.runtimeConfigGlobalConfig,
    "grok-workspace-config": s.runtimeConfigWorkspaceConfig,
    "grok-folder-trust": s.runtimeConfigFolderTrust,
  } as Record<string, string>)[id] ?? id;
  const settingLabel = (key: string, fallback: string) => ({
    theme: s.runtimeConfigTheme,
    prefersReducedMotion: s.runtimeConfigReducedMotion,
    spinnerTipsEnabled: s.runtimeConfigSpinnerTips,
    showTurnDuration: s.runtimeConfigTurnDuration,
    terminalProgressBarEnabled: s.runtimeConfigTerminalProgress,
    alwaysThinkingEnabled: s.runtimeConfigAlwaysThinking,
  } as Record<string, string>)[key] ?? fallback;
  const [runtimeId, setRuntimeId] = useState<RuntimeConfigRuntime>("codex");
  const runtime = snapshot?.runtimes.find((candidate) => candidate.runtime === runtimeId) ?? snapshot?.runtimes[0];
  const [documentId, setDocumentId] = useState("");
  const [unknownOpen, setUnknownOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<Record<string, string | boolean | string[] | number>>({});
  const [draftMcp, setDraftMcp] = useState<Record<string, boolean>>({});
  const config = runtime?.documents.find((document) => document.id === documentId) ?? runtime?.documents[0];
  const snapshotKey = `${runtime?.runtime ?? "missing"}:${config?.id ?? "missing"}:${config?.revision ?? "missing"}`;
  useEffect(() => {
    if (!config) return;
    const settings: Record<string, string | boolean | string[] | number> = {};
    for (const setting of config.knownSettings) {
      if (setting.editValue !== undefined) settings[setting.key] = setting.editValue;
    }
    setDraftSettings(settings);
    setDraftMcp(Object.fromEntries(config.mcpServers.map((server) => [server.name, server.enabled])));
  }, [snapshotKey]);
  // t-aa2780 — the degraded state keeps the section's H1. It was the one section body whose "no
  // snapshot yet / engine can't serve it" screen said nothing about WHICH section it was, which the
  // tab strip used to answer from outside. Same chrome as the loaded state, so the two do not read as
  // two different screens.
  if (!config) {
    return (
      <div class="rcp-root ds-page" data-testid="control-runtime-config">
        <PageChrome title={s.runtimeConfigTitle} hint={s.runtimeConfigHint} />
        <EmptyState kind={unavailable ? "error" : "loading"} message={unavailable ? s.runtimeConfigUnavailable : "Loading runtime configuration…"} />
      </div>
    );
  }
  const activeRuntime = runtime!;
  const initialSettings: Record<string, string | boolean | string[] | number> = Object.fromEntries(config.knownSettings.filter((setting) => setting.editValue !== undefined).map((setting) => [setting.key, setting.editValue])) as Record<string, string | boolean | string[] | number>;
  const initialMcp = Object.fromEntries(config.mcpServers.map((server) => [server.name, server.enabled]));
  const dirtySettings = Object.keys({ ...initialSettings, ...draftSettings }).some((key) => JSON.stringify(initialSettings[key]) !== JSON.stringify(draftSettings[key]));
  const dirtyMcp = Object.keys({ ...initialMcp, ...draftMcp }).some((name) => initialMcp[name] !== draftMcp[name]);
  const dirty = dirtySettings || dirtyMcp;
  const save = () => {
    const changes: Array<{ kind: "setting"; key: string; value: unknown } | { kind: "set-mcp-enabled"; name: string; enabled: boolean }> = [];
    for (const [key, value] of Object.entries(draftSettings)) {
      if (JSON.stringify(initialSettings[key]) !== JSON.stringify(value)) changes.push({ kind: "setting", key, value });
    }
    for (const [name, enabled] of Object.entries(draftMcp)) {
      if (initialMcp[name] !== enabled) changes.push({ kind: "set-mcp-enabled", name, enabled });
    }
    if (changes.length && runtime) onSaveChanges(runtime.runtime, config.id, config.revision, changes);
  };
  const cancel = () => {
    setDraftSettings(initialSettings);
    setDraftMcp(initialMcp);
  };
  return (
    <div class="rcp-root ds-page" data-testid="control-runtime-config">
      <PageChrome
        title={s.runtimeConfigTitle}
        hint={s.runtimeConfigHint}
        actions={<Badge tone="ok">Measured editor</Badge>}
      />

      <div class="rcp-toolbar">
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigRuntime}</span>
          <KitDropdown>
            <KitDropdownTrigger asChild>
              <button
                type="button"
                class="rcp-runtime-select"
                aria-label={s.runtimeConfigRuntime}
                data-testid="runtime-config-runtime-trigger"
              >
                <span class="rcp-runtime-logo"><RuntimeLogo id={activeRuntime.runtime} /></span>
                <span class="rcp-runtime-label">{runtimeLabel(activeRuntime.runtime)}</span>
                <span class="codicon codicon-chevron-down rcp-runtime-chevron" aria-hidden="true" />
              </button>
            </KitDropdownTrigger>
            <KitDropdownContent className="rcp-runtime-menu" align="start">
              {snapshot?.runtimes.map((candidate) => {
                const selected = candidate.runtime === activeRuntime.runtime;
                return (
                  <KitDropdownItem
                    key={candidate.runtime}
                    className="rcp-runtime-option"
                    data-testid={`runtime-config-runtime-${candidate.runtime}`}
                    onSelect={() => {
                      setRuntimeId(candidate.runtime);
                      setDocumentId(candidate.documents[0]?.id ?? "");
                    }}
                  >
                    <span class="rcp-runtime-logo"><RuntimeLogo id={candidate.runtime} /></span>
                    <span>{runtimeLabel(candidate.runtime)}</span>
                    {selected ? <span class="codicon codicon-check rcp-runtime-check" aria-label="Selected" /> : null}
                  </KitDropdownItem>
                );
              })}
            </KitDropdownContent>
          </KitDropdown>
        </div>
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigScope}</span>
          <div class="rcp-segmented" role="group" aria-label={s.runtimeConfigScope}>
            {runtime?.documents.map((document) => (
              <button type="button" class={document.id === config.id ? "active" : ""} onClick={() => setDocumentId(document.id)}>
                <span class={`codicon codicon-${document.scope === "global" ? "globe" : "folder"}`} /> {documentLabel(document.id)}
              </button>
            ))}
          </div>
        </div>
        <div class="rcp-toolbar-field">
          <span class="rcp-eyebrow">{s.runtimeConfigSourceFile}</span>
          <code class="rcp-toolbar-value rcp-source-value">{config.path}</code>
        </div>
        <div class="rcp-toolbar-action">
          <span class="rcp-eyebrow" aria-hidden="true">&nbsp;</span>
          <Button variant="default" onClick={() => onOpenSource(config.path)}>{s.runtimeConfigOpenFile}</Button>
        </div>
      </div>

      <div class="rcp-impact">
        <span>{s.runtimeConfigUsedBy} (potential)</span>
        <div class="rcp-agent-list">
          {runtime?.potentialAgents.length === 0 ? <span>{s.none}</span> : runtime?.potentialAgents.map((agent) => <Badge key={agent}>{agent}</Badge>)}
        </div>
      </div>
      {(runtime?.pendingAgents?.length ?? 0) > 0 ? <div class="rcp-global-warning" data-testid="runtime-config-pending">
        Current sessions still use the previous source. The next Start, Restart or Resume will apply this change: {runtime!.pendingAgents!.join(", ")}.
      </div> : null}
      {config.impact ? <div class="rcp-global-warning" data-testid="runtime-config-impact">{config.impact}</div> : null}
      {config.scope === "global" && !config.readOnly ? <div class="rcp-global-warning">{s.runtimeConfigGlobalWarning}</div> : null}

      {config.readOnly ? (
        <div class="rcp-actions-bar" role="region" aria-label="Runtime configuration actions">
          <span class="rcp-actions-state" data-testid="runtime-config-read-only">{s.runtimeConfigReadOnlyDocument}</span>
        </div>
      ) : (
        <div class="rcp-actions-bar" role="region" aria-label="Runtime configuration actions">
          <span class="rcp-actions-state" aria-live="polite">{dirty ? "Unsaved changes" : "No pending changes"}</span>
          <div class="rcp-card-actions">
            <Button variant="default" disabled={!dirty} onClick={cancel}>Cancel</Button>
            <Button variant="primary" disabled={!dirty} onClick={save}>{s.runtimeConfigSave}</Button>
          </div>
        </div>
      )}

      <div class="rcp-grid">
        <section class="rcp-card rcp-card--settings">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigEditable}</span>
              <h2>{runtime ? runtimeLabel(runtime.runtime) : ""} · {documentLabel(config.id)}</h2>
            </div>
            <Badge tone={config.exists ? "ok" : "default"}>{config.exists ? `${config.knownSettings.length} ${s.runtimeConfigConfigured}` : "Not found"}</Badge>
          </div>
          {config.parseError ? <div class="rcp-capability-empty">{s.runtimeConfigReadError}: {config.parseError}</div> : (
            <div class="rcp-setting-list">{config.knownSettings.map((setting) => {
              const boolean = setting.inputKind === "boolean" || setting.key === "tui.status_line_use_colors" || setting.key === "features.terminal_resize_reflow";
              const statusLine = setting.inputKind === "string-list" || setting.key === "tui.status_line";
              const numeric = setting.inputKind === "number";
              const raw = draftSettings[setting.key];
              const value = Array.isArray(raw) ? raw.join(", ") : raw === undefined ? (setting.editable ? "" : setting.value ?? "") : String(raw);
              const readInput = (event: Event) => (event.currentTarget as HTMLInputElement).value;
              return <div class="rcp-setting rcp-setting--editable" key={`${config.id}:${setting.key}`}>
                <label title={setting.readOnlyReason ?? ""}>
                  {settingLabel(setting.key, setting.label)}
                  {setting.shadowedBy ? ` (${s.runtimeConfigOverriddenBy} ${setting.shadowedBy})` : ""}
                  {setting.readOnlyReason ? <span class="rcp-setting-note"> — {setting.readOnlyReason}</span> : null}
                </label>
                <div class="rcp-setting-editor">
                  {boolean ? <input type="checkbox" checked={raw === true} disabled={!setting.editable} onInput={(event) => setDraftSettings((previous) => ({ ...previous, [setting.key]: (event.currentTarget as HTMLInputElement).checked }))} /> : (
                    <input
                      type={numeric ? "number" : "text"}
                      value={value}
                      disabled={!setting.editable}
                      placeholder={setting.editable ? s.runtimeConfigUnset : "Unsupported value"}
                      onInput={(event) => setDraftSettings((previous) => {
                        const text = readInput(event);
                        if (statusLine) return { ...previous, [setting.key]: text.split(",").map((item) => item.trim()).filter(Boolean) };
                        // A non-numeric draft is kept as typed so the measured host validator, not
                        // the field, is what refuses it.
                        if (numeric) return { ...previous, [setting.key]: text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text };
                        return { ...previous, [setting.key]: text };
                      })}
                    />
                  )}
                </div>
              </div>;
            })}</div>
          )}
        </section>

        <section class="rcp-card">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigCapabilities}</span>
              <h2>MCP servers</h2>
            </div>
          </div>
          <div class="rcp-capability-list">
            {config.mcpServers.length === 0 ? <div class="rcp-capability-empty">{s.none}</div> : config.mcpServers.map((server) => (
              <div class="rcp-capability-item" key={server.name}><div><strong>{server.name}</strong><span>{server.enabled ? "Configured in this source" : "Disabled in this source"}</span></div><label class="rcp-toggle"><input type="checkbox" disabled={server.editable === false} checked={draftMcp[server.name] ?? server.enabled} onInput={(event) => setDraftMcp((previous) => ({ ...previous, [server.name]: (event.currentTarget as HTMLInputElement).checked }))} /> {server.editable === false ? s.runtimeConfigReadOnly : draftMcp[server.name] ?? server.enabled ? "Enabled" : "Disabled"}</label></div>
            ))}
          </div>
        </section>

        <section class="rcp-card rcp-card--other">
          <div class="rcp-card-head">
            <div>
              <span class="rcp-eyebrow">{s.runtimeConfigOther}</span>
              <h2>{config.unknownKeys.length} {s.runtimeConfigDetected}</h2>
              <p>Values stay in the source file. This view lists only keys that are not yet editable in Control.</p>
            </div>
            <Button variant="default" onClick={() => setUnknownOpen((open) => !open)}>
              {s.runtimeConfigViewRaw}
            </Button>
          </div>
          {config.internalStateCount > 0 ? <div class="rcp-runtime-state">{config.internalStateCount} {s.runtimeConfigHiddenRecords}</div> : null}
          {(config.opaqueKeys?.length ?? 0) > 0 ? <div class="rcp-runtime-state">{s.runtimeConfigOpaqueSections}: {config.opaqueKeys!.join(", ")}.</div> : null}
          {config.unknownKeys.length === 0 ? <div class="rcp-capability-empty">{s.none}</div> : unknownOpen ? (
            <pre>{config.unknownKeys.join("\n")}</pre>
          ) : (
            <div class="rcp-other-preview">{config.unknownKeys.slice(0, 8).map((key) => <code key={key}>{key}</code>)}</div>
          )}
        </section>
      </div>
    </div>
  );
}
