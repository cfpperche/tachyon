import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { ToastProvider, useToast } from "../shared/ui";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import type { PluginsDispatch } from "./App";
import type { PluginsViewModel } from "../../plugins/viewModel";
import type { ConsentVM } from "../../plugins/consentViewModel";
import {
  BUSY,
  CONSENT,
  PLUGINS,
  RESULT,
  confirmMessage,
  pollAction,
  readyMessage,
  type ConfirmPayload,
} from "./messages";

/**
 * SDD 485 D2 — the Plugins app's OWN bootstrap.
 *
 * `./App` is byte-for-byte the component Control embedded; what changed is who mounts it. That is the whole
 * of the atomic-cutover rule as it applies here: `cockpit/App.tsx` no longer lazy-imports Plugins, so there
 * is exactly one live renderer of this screen and one client that can answer a host push.
 *
 * Three things this file gains that the Control embed borrowed from its host:
 *
 *  - the TOAST STACK. t-963b66 moved Plugins' result feedback off a local `.toast` slot onto the product
 *    `ToastProvider`, which inside Control was Control's own. `App.tsx` still renders no toast of its own
 *    (deliberately — it is unchanged), so the provider has to be here, and the `RESULT` arm below is the
 *    same `toastApi.show({context: "Plugins"})` `cockpit/main.tsx` ran, moved rather than rewritten;
 *  - its own 3s poll. Inside Control the model was re-posted by CONTROL's shell poll, which re-ran the
 *    active section's module every 3 seconds; standing alone, the app owns that timer. It sends `POLL`,
 *    NOT `refresh` — see the note on `pollAction` in `messages.ts`: the two mean different things to the
 *    host and collapsing them would wipe a just-found update check every three seconds (t-0fc9ee's bug,
 *    arriving by a new road). The timer is gated again HOST-side while the tab is hidden
 *    (`pluginsRefreshKind` → `PanelWorkGate`), so the client cannot reopen that door whatever it does;
 *  - its own error boundary, which is the per-app failure isolation `spec.md` reversed the app count for.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (message: unknown): void => {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
};

function PluginsRoot() {
  const toastApi = useToast();
  const [vm, setVm] = useState<PluginsViewModel | undefined>(undefined);
  const [consent, setConsent] = useState<ConsentVM | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === PLUGINS && raw.vm) {
        setVm(raw.vm as PluginsViewModel);
        setBusy(undefined);
      } else if (raw.type === CONSENT && raw.vm) {
        setConsent(raw.vm as ConsentVM);
        setBusy(undefined);
      } else if (raw.type === BUSY) {
        setBusy(typeof raw.label === "string" ? raw.label : "Working…");
      } else if (raw.type === RESULT) {
        // t-963b66 — Plugins ops land on the product Toast stack (not a local .toast slot). A failure
        // stays until dismissed (`durationMs: 0`); a success expires on the stack's default.
        const message = String(raw.message ?? "");
        if (message) {
          toastApi.show({
            message,
            tone: raw.ok ? "ok" : "err",
            context: "Plugins",
            durationMs: raw.ok ? undefined : 0,
          });
        }
        setBusy(undefined);
        setConsent(undefined);
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, [toastApi]);

  useEffect(() => {
    const timer = window.setInterval(() => post(pollAction()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  const dispatch = useMemo<PluginsDispatch>(
    () => ({
      refresh: () => post({ type: "refresh" }),
      checkUpdates: () => post({ type: "checkUpdates" }),
      checkPluginUpdate: (name: string) => post({ type: "checkPluginUpdate", name }),
      install: (spec: string) => post({ type: "install", spec }),
      update: (name: string) => post({ type: "update", name }),
      reinstall: (name: string) => post({ type: "reinstall", name }),
      remove: (name: string) => post({ type: "remove", name }),
      reselect: (runtimes: string[]) => post({ type: "reselect", runtimes }),
      repair: () => post({ type: "repair" }),
      rehydrate: () => post({ type: "rehydrate" }),
      confirm: (payload: ConfirmPayload) => post(confirmMessage(payload)),
      cancel: () => {
        setConsent(undefined);
        post({ type: "cancel" });
      },
      dismissToast: () => toastApi.clear(),
      openConfig: (name: string) => post({ type: "openConfig", name }),
      openDocs: (name: string) => post({ type: "openDocs", name }),
      installExternal: (externalTool: string, pluginName?: string) =>
        post({ type: "installExternal", externalTool, ...(pluginName ? { pluginName } : {}) }),
      applyMcp: (pluginName: string, server: string) => post({ type: "applyMcp", pluginName, server }),
      unapplyMcp: (pluginName: string, server: string) => post({ type: "unapplyMcp", pluginName, server }),
      applyContribution: (pluginName, kind, name) => post({ type: "applyContribution", pluginName, contributionKind: kind, contributionName: name }),
      unapplyContribution: (pluginName, kind, name) => post({ type: "unapplyContribution", pluginName, contributionKind: kind, contributionName: name }),
    }),
    [toastApi],
  );

  return <App vm={vm} consent={consent} busy={busy} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <ToastProvider>
        <PluginsRoot />
      </ToastProvider>
    </ErrorBoundary>,
    root,
  );
}
