/**
 * 516 — o webview da aba Plugins.
 *
 * Sem o temporizador de 3s que o antigo tinha: aquele existia para reconsultar estados de frescor que
 * mudavam sozinhos (uma tag nova no repositório de origem). O catálogo só muda quando o humano
 * instala ou remove, e as duas coisas passam por aqui.
 */
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { ToastProvider, useToast } from "../shared/ui";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, type PluginsDispatch, type ZipPickerState } from "./App";
import type { PluginsViewModel } from "@tachyon/engine/plugins/viewModel.js";
import { BUSY, PLUGINS, RESULT, ZIPS, readyMessage } from "./messages";

declare const acquireVsCodeApi: () => TachyonVsCodeApi;
const vscode = acquireVsCodeApi();
persistWebviewState(vscode);
const post = (message: unknown): void => vscode.postMessage(message);

function Root() {
  const toastApi = useToast();
  const [vm, setVm] = useState<PluginsViewModel | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [zips, setZips] = useState<ZipPickerState | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === PLUGINS && raw.vm) {
        setVm(raw.vm as PluginsViewModel);
        setBusy(undefined);
      } else if (raw.type === ZIPS) {
        setZips({
          candidates: (raw.candidates ?? []) as ZipPickerState["candidates"],
          roots: (raw.roots ?? []) as string[],
          ...(raw.listing ? { listing: raw.listing as ZipPickerState["listing"] } : {}),
          ...(raw.error ? { error: String(raw.error) } : {}),
        });
      } else if (raw.type === BUSY) {
        setBusy(typeof raw.label === "string" ? raw.label : "Working…");
      } else if (raw.type === RESULT) {
        const message = String(raw.message ?? "");
        if (message) {
          // Uma falha fica até ser dispensada; um sucesso expira sozinho.
          toastApi.show({ message, tone: raw.ok ? "ok" : "err", context: "Plugins", durationMs: raw.ok ? undefined : 0 });
        }
        setBusy(undefined);
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, [toastApi]);

  const dispatch = useMemo<PluginsDispatch>(() => ({
    refresh: () => post({ type: "refresh" }),
    install: () => post({ type: "install" }),
    browseZips: (dir: string) => post({ type: "browseZips", dir }),
    systemBrowseZip: () => { setZips(undefined); post({ type: "systemBrowseZip" }); },
    installFrom: (zipPath: string) => { setZips(undefined); post({ type: "installFrom", zipPath }); },
    closeZips: () => setZips(undefined),
    remove: (name: string) => post({ type: "remove", name }),
    openDocs: (name: string) => post({ type: "openDocs", name }),
  }), []);

  return <App vm={vm} busy={busy} zips={zips} dispatch={dispatch} />;
}

render(
  <ErrorBoundary>
    <ToastProvider><Root /></ToastProvider>
  </ErrorBoundary>,
  document.getElementById("root")!,
);
