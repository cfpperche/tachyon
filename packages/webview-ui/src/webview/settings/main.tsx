import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { GlobalSettingsState, SectionsModel } from "../../sections/model";
import { CardTemplateBlock } from "../shared/control/CardTemplateBlock";
import { formatCompanionPairClipboard, openGlobalSettingsFileAction, openPersonalCardTemplateAction, setGlobalSettingsAction, type CockpitAction, type CockpitStrings, type CompanionPairOffer } from "../shared/control/messages";
import { Button, PageChrome } from "../shared/ui";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { MODEL, pairOfferMessageType, pollSettingsAction, readyMessage, type SettingsAction } from "./messages";

function usePairCountdown(expiresAt?: string): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return { label: "", expired: false };
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return { label: "0:00", expired: true };
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return { label: `${m}:${String(s).padStart(2, "0")}`, expired: false };
}

/** Parse host globs from textarea (newlines and commas). */
export function parseAllowedHostsDraft(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    ),
  ];
}

/**
 * `t-585d5c` — the idle-notification window, in Control -> Settings.
 *
 * Three states rather than a number box: a value, the product default (nothing written), and off.
 * They are distinct on purpose — showing "10" for an unconfigured workspace would make a default
 * indistinguishable from a deliberate choice, and it is the difference a later reader needs.
 *
 * The field REFUSES a bad value locally rather than posting it: the runtime-api schema is still the
 * gate, but a save that silently does nothing is the worst version of this. The bounds shown are the
 * bounds enforced, both derived from the same setting.
 */
/**
 * t-aaad95 — the per-person half of Tachyon's settings, edited where every other Tachyon setting is
 * edited now that VS Code contributes none.
 *
 * Each row says whether it takes effect immediately or waits for Control to be reopened. That is not
 * decoration: with the VS Code settings UI gone there is no other place that would have told the
 * person their change did land, and "I changed it and nothing happened" is how a working setting gets
 * reported as a bug.
 */
/**
 * t-aaad95 (visual QA) — which file THIS block writes to.
 *
 * The two scope cards at the top of the page teach the split, and then the page is a flat stack of
 * blocks for the next 2300px with nothing saying which authority each one belongs to. Measured on the
 * shipped surface: a reader who scrolls past the first 230px has to re-derive the split from each
 * block's prose. The marker is per block because that is where the question is actually asked.
 */
function WritesTo({ s, file }: { s: CockpitStrings; file: "global" | "workspace" | "either" | "none" }) {
  const label = file === "either"
    ? s.settingsWritesToEither
    : file === "none"
      ? s.settingsWritesToNothing
      : `${s.settingsWritesTo} ${file === "global" ? s.settingsScopeGlobalTitle : s.settingsScopeWorkspaceTitle}`;
  return <p class="ck-settings-block-scope" data-testid={`settings-writes-to-${file}`}>{label}</p>;
}

function GlobalSettingsBlock({
  s,
  settings,
  onPost,
}: {
  s: CockpitStrings;
  settings: GlobalSettingsState;
  onPost: (action: CockpitAction) => void;
}) {
  const [gitPath, setGitPath] = useState(settings.gitPath);
  useEffect(() => {
    setGitPath(settings.gitPath);
  }, [settings.gitPath]);

  return (
    <div class="ck-settings-block" data-testid="control-settings-global">
      <h3 class="ck-settings-block-title">{s.globalSettingsTitle}</h3>
      <WritesTo s={s} file="global" />
      <p class="ck-settings-block-hint">{s.globalSettingsHint}</p>
      <p class="ck-settings-block-body dim" data-testid="global-settings-file">
        {s.globalSettingsFileLabel} <code>{settings.file}</code>
      </p>
      {settings.refusal?.length ? (
        <p class="ck-settings-block-body" data-testid="global-settings-refusal">
          {s.globalSettingsRefused} {settings.refusal.join("; ")}
        </p>
      ) : null}

      <div class="ck-settings-hosts-actions">
        <label class="ck-settings-hosts-label" for="global-settings-code-theme">
          <strong>{s.globalSettingsCodeTheme}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsCodeThemeHelp}</span>
        </label>
        <select
          id="global-settings-code-theme"
          class="ck-settings-hosts-input"
          data-testid="global-settings-code-theme"
          value={settings.activityCodeTheme}
          onChange={(e) =>
            onPost(setGlobalSettingsAction({
              activityCodeTheme: (e.target as HTMLSelectElement).value as "auto" | "dark" | "light",
            }))
          }
        >
          <option value="auto">{s.globalSettingsCodeThemeAuto}</option>
          <option value="dark">{s.globalSettingsCodeThemeDark}</option>
          <option value="light">{s.globalSettingsCodeThemeLight}</option>
        </select>
        <span class="ck-settings-toggle-help">{s.globalSettingsNeedsReopen}</span>
      </div>

      <label class="ck-settings-toggle">
        <input
          type="checkbox"
          checked={settings.agentPaneEnabled}
          data-testid="global-settings-agent-pane"
          onChange={(e) => onPost(setGlobalSettingsAction({ agentPaneEnabled: (e.target as HTMLInputElement).checked }))}
        />
        <span>
          <strong>{s.globalSettingsAgentPane}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsAgentPaneHelp} — {s.globalSettingsLive}</span>
        </span>
      </label>

      <div class="ck-settings-hosts-actions">
        <label class="ck-settings-hosts-label" for="global-settings-git-path">
          <strong>{s.globalSettingsGitPath}</strong>
          <span class="ck-settings-toggle-help">{s.globalSettingsGitPathHelp} — {s.globalSettingsLive}</span>
        </label>
        <input
          id="global-settings-git-path"
          type="text"
          class="ck-settings-hosts-input"
          data-testid="global-settings-git-path"
          value={gitPath}
          onInput={(e) => setGitPath((e.target as HTMLInputElement).value)}
        />
        <Button
          variant="default"
          disabled={gitPath === settings.gitPath}
          data-testid="global-settings-git-path-save"
          onClick={() => onPost(setGlobalSettingsAction({ gitPath }))}
        >
          {s.globalSettingsSave}
        </Button>
      </div>

      <div class="ck-settings-hosts-actions">
        <Button
          variant="default"
          data-testid="global-settings-open-file"
          onClick={() => onPost(openGlobalSettingsFileAction())}
        >
          {s.globalSettingsOpenFile}
        </Button>
      </div>
    </div>
  );
}

function IdleNotifyField({
  s,
  idle,
  onSave,
}: {
  s: CockpitStrings;
  idle: NonNullable<SectionsModel["idleNotify"]>;
  onSave: (wsHash: string, minutes?: number | "never") => void;
}) {
  const off = idle.configured === "never";
  const serverValue = typeof idle.configured === "number" ? String(idle.configured) : "";
  const [draft, setDraft] = useState(serverValue);
  useEffect(() => {
    setDraft(serverValue);
  }, [idle.wsHash, serverValue]);

  const parsed = Number(draft.trim());
  const valid = draft.trim().length > 0 && Number.isFinite(parsed) && parsed > 0 && parsed <= 10080;
  const dirty = draft.trim() !== serverValue;

  return (
    <div class="ck-settings-block" data-testid="control-settings-idle-notify">
      <h3 class="ck-settings-block-title">{s.idleNotifyTitle}</h3>
      <WritesTo s={s} file="workspace" />
      <p class="ck-settings-block-hint">{s.idleNotifyHelp}</p>
      {idle.configured === undefined ? (
        <p class="ck-settings-block-body dim" data-testid="idle-notify-default">
          {s.idleNotifyUsingDefault.replace("{0}", String(idle.defaultMinutes))}
        </p>
      ) : null}
      {off ? <p class="ck-settings-block-body dim" data-testid="idle-notify-off">{s.idleNotifyOff}</p> : null}
      <div class="ck-settings-hosts-actions">
        <input
          type="number"
          min={1}
          max={10080}
          class="ck-settings-hosts-input"
          data-testid="idle-notify-input"
          value={draft}
          disabled={off}
          placeholder={String(idle.defaultMinutes)}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        />
        <span class="ck-settings-toggle-help">{s.idleNotifyUnit}</span>
        <Button
          variant="default"
          disabled={off || !valid || !dirty}
          data-testid="idle-notify-save"
          onClick={() => onSave(idle.wsHash, parsed)}
        >
          {s.idleNotifySave}
        </Button>
        <Button
          variant="default"
          disabled={idle.configured === undefined}
          data-testid="idle-notify-reset"
          onClick={() => onSave(idle.wsHash, undefined)}
        >
          {s.idleNotifyReset}
        </Button>
      </div>
      <label class="ck-settings-toggle">
        <input
          type="checkbox"
          checked={off}
          data-testid="idle-notify-off-toggle"
          onChange={(e) =>
            onSave(idle.wsHash, (e.target as HTMLInputElement).checked ? "never" : idle.defaultMinutes)
          }
        />
        <span>
          <strong>{s.idleNotifyOffLabel}</strong>
        </span>
      </label>
    </div>
  );
}

function CompanionAllowedHostsField({
  s,
  wsHash,
  allowedHosts,
  onSave,
}: {
  s: CockpitStrings;
  wsHash: string;
  allowedHosts: string[];
  onSave: (wsHash: string, hosts: string[]) => void;
}) {
  const serverKey = allowedHosts.join("\n");
  const [draft, setDraft] = useState(serverKey);
  useEffect(() => {
    setDraft(serverKey);
  }, [wsHash, serverKey]);
  const dirty = parseAllowedHostsDraft(draft).join("\n") !== serverKey;
  return (
    <div class="ck-settings-hosts" data-testid="companion-allowed-hosts">
      <div class="ck-settings-hosts-label">
        <strong>{s.companionAllowedHosts}</strong>
        <span class="ck-settings-toggle-help">{s.companionAllowedHostsHelp}</span>
      </div>
      <textarea
        class="ck-settings-hosts-input"
        data-testid="companion-allowed-hosts-input"
        rows={3}
        value={draft}
        placeholder={s.companionAllowedHostsPlaceholder}
        spellcheck={false}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
      />
      <div class="ck-settings-hosts-actions">
        <Button
          variant="default"
          data-testid="companion-allowed-hosts-save"
          disabled={!dirty}
          onClick={() => onSave(wsHash, parseAllowedHostsDraft(draft))}
        >
          {s.companionAllowedHostsSave}
        </Button>
      </div>
    </div>
  );
}

function CompanionPairOfferCard({
  s,
  offer,
  onCopyText,
  onNewCode,
}: {
  s: CockpitStrings;
  offer: CompanionPairOffer;
  onCopyText: (text: string) => void;
  onNewCode: () => void;
}) {
  const expiresAt = offer.ok ? offer.expiresAt : undefined;
  const { label: countdown, expired } = usePairCountdown(expiresAt);

  if (!offer.ok) {
    return (
      <div class="ck-pair-offer ck-pair-offer-err" data-testid="companion-pair-offer">
        <p class="ck-settings-block-body">
          {s.companionPairUnavailable}
          {offer.reason ? <span class="dim"> ({offer.reason})</span> : null}
        </p>
        <div class="ck-pair-offer-actions">
          <Button variant="default" data-testid="companion-pair-retry" onClick={onNewCode}>
            {s.companionShowPairCode}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="ck-pair-offer" data-testid="companion-pair-offer">
      {expired ? (
        <p class="ck-settings-block-body dim" data-testid="companion-pair-expired">
          {s.companionPairExpired}
        </p>
      ) : null}
      {offer.qrDataUrl ? (
        <div class="ck-pair-offer-qr" data-testid="companion-pair-qr">
          <span class="ck-pair-offer-label">{s.companionPairQrLabel}</span>
          <img
            class="ck-pair-offer-qr-img"
            src={offer.qrDataUrl}
            width={200}
            height={200}
            alt={s.companionPairQrLabel}
          />
          <p class="ck-settings-block-body dim">{s.companionPairQrHint}</p>
        </div>
      ) : null}
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairCodeLabel}</span>
        <span class="ck-pair-offer-code ck-mono" data-testid="companion-pair-code">
          {offer.code}
        </span>
      </div>
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairUrlLabel}</span>
        <span class="ck-pair-offer-url ck-mono" data-testid="companion-pair-url" title={offer.baseUrl}>
          {offer.baseUrl}
        </span>
      </div>
      {offer.openUrl ? (
        <div class="ck-pair-offer-row">
          <span class="ck-pair-offer-label">open</span>
          <span class="ck-pair-offer-url ck-mono" data-testid="companion-pair-open-url" title={offer.openUrl}>
            {offer.openUrl}
          </span>
        </div>
      ) : null}
      <p class="ck-settings-block-body dim" data-testid="companion-lan-hint">
        {s.companionLanAccessHint}
      </p>
      <div class="ck-pair-offer-row">
        <span class="ck-pair-offer-label">{s.companionPairExpires}</span>
        <span class="ck-mono" data-testid="companion-pair-expires">
          {expired ? "0:00" : countdown}
          {!expired && expiresAt ? (
            <span class="dim"> · {expiresAt.slice(0, 19).replace("T", " ")}</span>
          ) : null}
        </span>
      </div>
      <div class="ck-pair-offer-actions">
        <Button
          variant="default"
          data-testid="companion-pair-copy-code"
          disabled={expired}
          onClick={() => onCopyText(offer.code)}
        >
          {s.companionCopyCode}
        </Button>
        {offer.openUrl ? (
          <Button
            variant="default"
            data-testid="companion-pair-copy-open-url"
            disabled={expired}
            onClick={() => onCopyText(offer.openUrl!)}
          >
            {s.companionCopyUrl}
          </Button>
        ) : (
          <Button
            variant="default"
            data-testid="companion-pair-copy-url"
            onClick={() => onCopyText(offer.baseUrl)}
          >
            {s.companionCopyUrl}
          </Button>
        )}
        <Button
          variant="default"
          data-testid="companion-pair-copy-all"
          disabled={expired}
          onClick={() => onCopyText(formatCompanionPairClipboard(offer))}
        >
          {s.companionCopyAll}
        </Button>
        <Button variant="default" data-testid="companion-pair-new-code" onClick={onNewCode}>
          {s.companionNewCode}
        </Button>
      </div>
    </div>
  );
}



export interface SettingsAppProps { model: SectionsModel; strings: CockpitStrings; pairOffer?: CompanionPairOffer; post: (action: CockpitAction | SettingsAction) => void; }
export function SettingsApp({ model: m, strings: s, pairOffer, post }: SettingsAppProps) {
  const p = { onOpenDoctor: () => post({type:"openDoctor"}), onOpenSettings: () => post({type:"openGlobalSettingsFile"}), onOpenConfigFile: (wsHash?: string) => post({type:"openConfigFile",wsHash}), onPost: post, onSetIdleAfterMinutes: (wsHash:string,minutes?:number|"never") => post({type:"setIdleAfterMinutes",wsHash,minutes}), onSetCompanionTabTools:(wsHash:string,enabled:boolean)=>post({type:"setCompanionTabTools",wsHash,enabled}), onSetIdeBrowserEnabled:(wsHash:string,enabled:boolean)=>post({type:"setIdeBrowserEnabled",wsHash,enabled}), onSetCompanionAllowedHosts:(wsHash:string,hosts:string[])=>post({type:"setCompanionAllowedHosts",wsHash,hosts}), onIssueCompanionPairCode:(wsHash:string)=>post({type:"issueCompanionPairCode",wsHash}), onCopyText:(text:string)=>post({type:"copyText",text}), onUnpairCompanionDevice:(wsHash:string,deviceId:string)=>post({type:"unpairCompanionDevice",wsHash,deviceId}), companionPairOffer: pairOffer };
    const companion = m.companion;
    const ideBrowser = m.ideBrowser;
    const settingsWsHash = companion?.wsHash ?? m.control.workspaces[0]?.wsHash;
    const settingsWorkspace = m.control.workspaces.find((w) => w.wsHash === settingsWsHash) ?? m.control.workspaces[0];
    // Display path only — openConfigFile still resolves the live file through the host.
    const workspaceSettingsPath = settingsWorkspace
      ? `${settingsWorkspace.workspaceRoot.replace(/[/\\]+$/, "")}/tachyon.yml`
      : "tachyon.yml";

    return <><PageChrome title={s.settingsTitle} hint={s.settingsHint} actions={<Button variant="primary" onClick={p.onOpenDoctor}>{s.settingsDoctor}</Button>} /><div>
        <div class="ck-panel" data-testid="control-settings">
          {/* t-7b4bb5 — scope split first: two authorities, named paths, no VS Code settings detour. */}
          <p class="ck-settings-intro" data-testid="control-settings-intro">{s.settingsBody}</p>
          <div class="ck-settings-scopes" data-testid="control-settings-scopes">
            <section class="ck-settings-scope" data-testid="control-settings-scope-global" aria-labelledby="ck-settings-scope-global-title">
              <h3 class="ck-settings-scope-title" id="ck-settings-scope-global-title">{s.settingsScopeGlobalTitle}</h3>
              <p class="ck-settings-scope-hint">{s.settingsScopeGlobalHint}</p>
              {m.globalSettings?.file ? (
                <p class="ck-settings-scope-path" data-testid="control-settings-global-path">
                  <span class="ck-settings-scope-path-label">{s.settingsFileLabel}</span>{" "}
                  <code class="ck-settings-path">{m.globalSettings.file}</code>
                </p>
              ) : null}
              <div class="ck-settings-scope-actions">
                <Button variant="default" data-testid="control-settings-open-global" onClick={p.onOpenSettings}>
                  {s.settingsOpenTachyon}
                </Button>
              </div>
            </section>
            <section class="ck-settings-scope" data-testid="control-settings-scope-workspace" aria-labelledby="ck-settings-scope-workspace-title">
              <h3 class="ck-settings-scope-title" id="ck-settings-scope-workspace-title">{s.settingsScopeWorkspaceTitle}</h3>
              <p class="ck-settings-scope-hint">{s.settingsScopeWorkspaceHint}</p>
              <p class="ck-settings-scope-path" data-testid="control-settings-workspace-path">
                <span class="ck-settings-scope-path-label">{s.settingsFileLabel}</span>{" "}
                <code class="ck-settings-path">{workspaceSettingsPath}</code>
              </p>
              <div class="ck-settings-scope-actions">
                <Button
                  variant="default"
                  data-testid="control-settings-open-workspace"
                  onClick={() => p.onOpenConfigFile(settingsWsHash)}
                >
                  {s.settingsOpenConfig}
                </Button>
              </div>
            </section>
          </div>
          {/* SDD 479 phase 4 — compose a card layout and watch the REAL card update (ratified fork 5). */}
          <CardTemplateBlock
            s={s}
            onOpenConfig={() => p.onOpenConfigFile(settingsWsHash)}
            // SDD 479 phase 5 — the personal home is a settings KEY, so its button opens the settings
            // editor filtered to that key rather than a file.
            onOpenSettings={() => p.onPost(openPersonalCardTemplateAction())}
            inEffect={m.cardTemplate}
          />

          {m.globalSettings ? <GlobalSettingsBlock s={s} settings={m.globalSettings} onPost={p.onPost} /> : null}

          {/* t-aaad95 (visual QA) — the second workspace card is GONE. It repeated the "Workspace
            * (project)" scope card verbatim 1400px above it: same file path, same button, overlapping
            * hint. Two cards for one authority taught the reader to check whether they differed. Its
            * one unique sentence — which knobs live in the yml — moved into the scope card's hint. */}
          {m.idleNotify ? <IdleNotifyField s={s} idle={m.idleNotify} onSave={p.onSetIdleAfterMinutes} /> : null}

          {/* SDD 488 F4 — Integrated Browser human surface gate (tools stay always-registered). */}
          <div class="ck-settings-block" data-testid="control-settings-ide-browser">
            <h3 class="ck-settings-block-title">{s.ideBrowserTitle}</h3>
            <WritesTo s={s} file="workspace" />
            <p class="ck-settings-block-hint">{s.ideBrowserHint}</p>
            {m.companionNeedsWorkspacePick ? (
              <p class="ck-settings-block-body dim">{s.companionPickWorkspace}</p>
            ) : ideBrowser ? (
              <>
                <p class="ck-settings-block-body">{s.ideBrowserBody}</p>
                <label class="ck-settings-toggle">
                  <input
                    type="checkbox"
                    checked={ideBrowser.enabled}
                    data-testid="ide-browser-enabled-toggle"
                    onChange={(e) =>
                      p.onSetIdeBrowserEnabled(ideBrowser.wsHash, (e.target as HTMLInputElement).checked)
                    }
                  />
                  <span>
                    <strong>{s.ideBrowserEnabled}</strong>
                    <span class="ck-settings-toggle-help">{s.ideBrowserEnabledHelp}</span>
                  </span>
                </label>
              </>
            ) : settingsWsHash ? (
              <>
                <p class="ck-settings-block-body">{s.ideBrowserBody}</p>
                <label class="ck-settings-toggle">
                  <input
                    type="checkbox"
                    checked={false}
                    data-testid="ide-browser-enabled-toggle"
                    onChange={(e) =>
                      p.onSetIdeBrowserEnabled(settingsWsHash, (e.target as HTMLInputElement).checked)
                    }
                  />
                  <span>
                    <strong>{s.ideBrowserEnabled}</strong>
                    <span class="ck-settings-toggle-help">{s.ideBrowserEnabledHelp}</span>
                  </span>
                </label>
              </>
            ) : null}
          </div>

          <div class="ck-settings-block" data-testid="control-settings-companion">
            <h3 class="ck-settings-block-title">{s.companionTitle}</h3>
            <WritesTo s={s} file="workspace" />
            <p class="ck-settings-block-hint">{s.companionHint}</p>
            {m.companionNeedsWorkspacePick ? (
              <p class="ck-settings-block-body dim">{s.companionPickWorkspace}</p>
            ) : companion ? (
              <>
                <p class="ck-settings-block-body">{s.companionBody}</p>
                <label class="ck-settings-toggle">
                  <input
                    type="checkbox"
                    checked={companion.tabTools}
                    data-testid="companion-tab-tools-toggle"
                    onChange={(e) =>
                      p.onSetCompanionTabTools(companion.wsHash, (e.target as HTMLInputElement).checked)
                    }
                  />
                  <span>
                    <strong>{s.companionTabTools}</strong>
                    <span class="ck-settings-toggle-help">{s.companionTabToolsHelp}</span>
                  </span>
                </label>
                <CompanionAllowedHostsField
                  s={s}
                  wsHash={companion.wsHash}
                  allowedHosts={companion.allowedHosts}
                  onSave={p.onSetCompanionAllowedHosts}
                />
                <div class="ck-settings-status" data-testid="companion-pair-status">
                  <span class={`ck-badge ${companion.paired ? "ok" : "muted"}`}>
                    {companion.paired ? s.companionPaired : s.companionNotPaired}
                  </span>
                  {companion.baseUrl ? (
                    <span class="ck-mono" title={s.companionBaseUrl}>
                      {companion.baseUrl}
                    </span>
                  ) : null}
                  <span class="dim">{companion.folderName}</span>
                </div>

                <div class="ck-pair-actions" data-testid="companion-pair-actions">
                  <Button
                    variant="default"
                    data-testid="companion-show-pair-code"
                    onClick={() => p.onIssueCompanionPairCode(companion.wsHash)}
                  >
                    {s.companionShowPairCode}
                  </Button>
                  {companion.baseUrl ? (
                    <Button
                      variant="default"
                      data-testid="companion-copy-base-url"
                      onClick={() => p.onCopyText(companion.baseUrl!)}
                    >
                      {s.companionCopyBaseUrl}
                    </Button>
                  ) : null}
                </div>
                {p.companionPairOffer ? (
                  <CompanionPairOfferCard
                    s={s}
                    offer={p.companionPairOffer}
                    onCopyText={p.onCopyText}
                    onNewCode={() => p.onIssueCompanionPairCode(companion.wsHash)}
                  />
                ) : null}

                <div class="ck-settings-block ck-settings-block-nested" data-testid="control-settings-devices">
                  <h3 class="ck-settings-block-title">{s.devicesTitle}</h3>
                  <p class="ck-settings-block-hint">{s.devicesHint}</p>
                  {companion.devices.length === 0 ? (
                    <p class="ck-settings-block-body dim" data-testid="companion-devices-empty">
                      {s.devicesEmpty}
                    </p>
                  ) : (
                    <ul class="ck-device-list">
                      {companion.devices.map((d) => (
                        <li key={d.id} class="ck-device-row" data-testid="companion-device-row">
                          <div class="ck-device-main">
                            <div class="ck-device-name">
                              <strong>{d.name}</strong>
                              {d.version ? <span class="dim"> · {d.version}</span> : null}
                            </div>
                            <div class="ck-device-meta">
                              <span class="dim">
                                {d.kind === "mobile" ? s.devicesKindMobile : s.devicesKindBrowser}
                              </span>
                              <span class={`ck-badge ${d.live ? "ok" : "muted"}`}>
                                {d.live ? s.devicesLive : s.devicesOffline}
                              </span>
                              {d.pairedAt ? (
                                <span class="dim" title={d.pairedAt}>
                                  {s.devicesPairedAt} {d.pairedAt.slice(0, 19).replace("T", " ")}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <Button
                            variant="default"
                            data-testid="companion-device-unpair"
                            onClick={() => p.onUnpairCompanionDevice(companion.wsHash, d.id)}
                          >
                            {s.devicesUnpair}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p class="ck-settings-block-body dim">{s.empty}</p>
            )}
          </div>
        </div>
      </div></>
}

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: CockpitAction | SettingsAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");
export function SettingsRoot() { const [model,setModel]=useState<SectionsModel>(); const [pairOffer,setPairOffer]=useState<CompanionPairOffer>(); const strings=(window as any).__TACHYON_STRINGS__ as CockpitStrings; useEffect(()=>{ const onMessage=(e:MessageEvent)=>{if(e.data?.type===MODEL)setModel(e.data.model);if(e.data?.type===pairOfferMessageType)setPairOffer(e.data.offer)}; window.addEventListener("message",onMessage); post(readyMessage()); const timer=setInterval(()=>post(pollSettingsAction()),3000); return()=>{clearInterval(timer);window.removeEventListener("message",onMessage)}},[]); return model?<main class="ds-page"><SettingsApp model={model} strings={strings} pairOffer={pairOffer} post={post}/></main>:null; }
const root=document.getElementById("root"); if(root) render(<ErrorBoundary><SettingsRoot/></ErrorBoundary>,root);
