import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import type { RuntimeOpsProviderV2, RuntimeOpsSnapshot } from "../../runtimeOps/types";
import type { InspectedSession } from "../../runtimeOps/sessionInspection";
import {
  RUNTIME_OPS_LOADING,
  RUNTIME_OPS_SNAPSHOT,
  RUNTIME_OPS_SESSION_INSPECTION,
  readyMessage,
  runtimeOpsInspectSessionAction,
  runtimeOpsPollAction,
  runtimeOpsSetProviderObservationAction,
  type SessionInspectionState,
} from "./messages";

/**
 * SDD 485 D3 — the Runtime Ops app's OWN bootstrap.
 *
 * `./App` is byte-for-byte the component Control embedded; what changed is who mounts it. That is the
 * whole of the atomic-cutover rule as it applies here: `cockpit/App.tsx` no longer lazy-imports Runtime
 * Ops, so there is exactly one live renderer of this screen and one client that can answer a host push.
 *
 * Three things this file gains that the Control embed borrowed from its host:
 *
 *  - its own 3s poll. Inside Control the snapshot was re-posted by CONTROL's shell poll, which re-ran the
 *    active section's module every three seconds; standing alone, the app owns that timer. It sends
 *    `POLL` — a word minted for it rather than borrowed, see `messages.ts` — and the timer is gated again
 *    HOST-side while the tab is hidden (`runtimeOpsRefreshKind` → `PanelWorkGate`), so the client cannot
 *    reopen Phase B's loudest door whatever timer a client version happens to run;
 *  - the two client-side state slots Control's `main.tsx` held for it: the snapshot, and t-283149's
 *    per-row `sessionInspections` map. Both were already per-webview inside Control and both are per
 *    webview here, which for a `window` app is also per panel — there is exactly one;
 *  - its own error boundary, which is the per-app failure isolation `spec.md` reversed the app count for.
 *
 * No `ToastProvider`: this surface raises no toasts and never did — unlike Plugins (D2), whose result
 * envelope needed the stack Control owned. A provider with no caller would be exactly the decorative
 * mechanism the conformance contract's second half exists to refuse.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (message: unknown): void => {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
};

function RuntimeOpsRoot() {
  const [snapshot, setSnapshot] = useState<RuntimeOpsSnapshot | undefined>(undefined);
  /** t-283149 — keyed by `<wsHash>:<agent>`; only rows the person expanded are ever present. */
  const [sessionInspections, setSessionInspections] = useState<Record<string, SessionInspectionState>>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === RUNTIME_OPS_SNAPSHOT && raw.snapshot) {
        setSnapshot(raw.snapshot as RuntimeOpsSnapshot);
      } else if (raw.type === RUNTIME_OPS_LOADING) {
        // The explicit host loading state (`messages.ts`): back to the same surface the first mount shows,
        // rather than leaving the previous snapshot on screen claiming to be current.
        setSnapshot(undefined);
      } else if (raw.type === RUNTIME_OPS_SESSION_INSPECTION && typeof raw.agentKey === "string") {
        const agentKey = raw.agentKey;
        const next: SessionInspectionState = raw.inspection
          ? { status: "ready", inspection: raw.inspection as InspectedSession }
          : { status: "error", message: typeof raw.error === "string" ? raw.error : "Session inspection failed." };
        // A reply for a row the person already collapsed is dropped: re-adding it would make the row
        // reopen-with-stale-data on the next expand instead of re-reading a live process. Carried over
        // from `cockpit/main.tsx` verbatim — the race is the panel's, not Control's.
        setSessionInspections((prev) => (agentKey in prev ? { ...prev, [agentKey]: next } : prev));
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => post(runtimeOpsPollAction()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <App
      snapshot={snapshot}
      onSetProviderObservation={(provider: RuntimeOpsProviderV2, enabled: boolean) =>
        post(runtimeOpsSetProviderObservationAction(provider, enabled))
      }
      sessionInspections={sessionInspections}
      onToggleSessionInspection={(workspaceKey: string, agent: string, open: boolean) => {
        const agentKey = `${workspaceKey}:${agent}`;
        setSessionInspections((prev) => {
          if (!open) {
            const { [agentKey]: _dropped, ...rest } = prev;
            return rest;
          }
          return { ...prev, [agentKey]: { status: "loading" } };
        });
        // Every expand re-asks. A session inspection is a reading of a LIVE process; serving a cached one
        // would show settings the agent no longer runs under, which is the exact failure this panel exists
        // to end.
        if (open) post(runtimeOpsInspectSessionAction(workspaceKey, agent));
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <RuntimeOpsRoot />
    </ErrorBoundary>,
    root,
  );
}
