import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { ToastProvider } from "../shared/ui";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import type { InspectorModel } from "../../inspector/model";
import {
  CAPTURE,
  INIT,
  MODEL,
  captureAction,
  killAction,
  openAction,
  readyMessage,
  reapDeadAction,
  reapOrphansAction,
  refreshAction,
  type InspectorStrings,
} from "./messages";

/**
 * SDD 485 D1 — the tmux Server Inspector's OWN bootstrap.
 *
 * `./App` is byte-for-byte the component Control embedded; what changed is who mounts it. That is the whole
 * of the atomic-cutover rule as it applies here: `cockpit/App.tsx` no longer lazy-imports the inspector, so
 * there is exactly one live renderer of this screen and one client that can answer a host push.
 *
 * Two things this file gains that the Control embed borrowed from its host:
 *
 *  - the SHARED envelope. Inside Control the host had to namespace its pushes (`inspectorInit`,
 *    `inspectorModel`, `inspectorCapture`) to avoid colliding with Control's own `init`/`model`. Standing
 *    alone there is nothing to collide with, so the app uses the `INIT`/`MODEL`/`CAPTURE` constants
 *    `inspector/messages.ts` has declared since spec 279 and that the preview harness reads;
 *  - its own auto-refresh timer. The checkbox used to drive CONTROL's 3s poll, which happened to re-push
 *    the inspector as part of re-pushing whatever section was active. Here it drives this app's own
 *    `refresh`, at the same 3s cadence and defaulting on, exactly as it behaved as a section. The timer is
 *    conditional on the checkbox (a product feature) and gated again HOST-side while the tab is hidden
 *    (`tmuxRefreshKind` → `PanelWorkGate`) — the client cannot reopen that door whatever it does.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (message: unknown): void => {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
};

function InspectorRoot() {
  const [strings, setStrings] = useState<InspectorStrings | undefined>(undefined);
  const [model, setModel] = useState<InspectorModel | undefined>(undefined);
  const [captures, setCaptures] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === INIT && raw.strings) setStrings(raw.strings as InspectorStrings);
      else if (raw.type === MODEL && raw.model) setModel(raw.model as InspectorModel);
      else if (raw.type === CAPTURE && typeof raw.session === "string") {
        setCaptures((prev) => ({ ...prev, [raw.session as string]: String(raw.text ?? "") }));
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = window.setInterval(() => post(refreshAction()), 3000);
    return () => window.clearInterval(timer);
  }, [auto]);

  const dispatch = useMemo(
    () => ({
      onToggleAuto: setAuto,
      onToggleCapture: (session: string) => {
        setOpen((prev) => {
          const next = new Set(prev);
          next.add(session);
          return next;
        });
        post(captureAction(session));
      },
      onCloseCapture: (session: string) => {
        setOpen((prev) => {
          const next = new Set(prev);
          next.delete(session);
          return next;
        });
      },
      onAction: (a: { type: "refresh" | "reapDead" | "reapOrphans" } | { type: "open" | "kill"; session: string }) => {
        if (a.type === "refresh") post(refreshAction());
        else if (a.type === "reapDead") post(reapDeadAction());
        else if (a.type === "reapOrphans") post(reapOrphansAction());
        else if (a.type === "open") post(openAction(a.session));
        else if (a.type === "kill") post(killAction(a.session));
      },
    }),
    [],
  );

  return <App model={model} strings={strings} captures={captures} open={open} auto={auto} {...dispatch} />;
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <ToastProvider>
        <InspectorRoot />
      </ToastProvider>
    </ErrorBoundary>,
    root,
  );
}
