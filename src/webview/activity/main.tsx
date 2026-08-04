import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ActivityViewModel } from "../../activity/activityView";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, type ActivityDispatch, type PendingShareAgentTargets } from "./App";
import {
  ACTIVITY,
  IMAGE_DATA,
  SHARE_AGENT_TARGETS,
  copyShareTextMessage,
  readyMessage,
  shareExternalMessage,
  shareToAgentMessage,
  type ExternalShareChannel,
} from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: unknown): void => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function ActivityRoot() {
  const [vm, setVm] = useState<ActivityViewModel>();
  const [prepended, setPrepended] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<PendingShareAgentTargets | null>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === ACTIVITY && raw.vm) {
        setVm(raw.vm as ActivityViewModel);
        setPrepended(raw.prepended === true);
      } else if (raw.type === IMAGE_DATA && typeof raw.id === "string" && typeof raw.dataUri === "string") {
        setImages((current) => current[raw.id as string] ? current : { ...current, [raw.id as string]: raw.dataUri as string });
      } else if (raw.type === SHARE_AGENT_TARGETS && typeof raw.sequence === "number" && typeof raw.key === "string") {
        const items = Array.isArray(raw.targets)
          ? (raw.targets as Array<{ name?: string; description?: string }>).filter((item) => typeof item.name === "string")
              .map((item) => ({ name: item.name!, description: typeof item.description === "string" ? item.description : "" }))
          : [];
        setTargets({ sequence: raw.sequence, key: raw.key, targets: items });
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const dispatch = useMemo<ActivityDispatch>(() => ({
    openFile: (path) => post({ type: "openFile", path }),
    terminal: () => post({ type: "terminal" }),
    loadOlder: () => post({ type: "loadOlder" }),
    copyShareText: (sequence, key) => post(copyShareTextMessage(sequence, key)),
    shareExternal: (sequence, key, channel: ExternalShareChannel) => post(shareExternalMessage(sequence, key, channel)),
    shareToAgent: (sequence, key, toAgent?) => post(shareToAgentMessage(sequence, key, toAgent)),
  }), []);

  return (
    <main class="ds-page activity-page" ref={scrollContainer}>
      <App
        vm={vm}
        prepended={prepended}
        images={images}
        dispatch={dispatch}
        scrollContainer={scrollContainer}
        pendingShareAgentTargets={targets}
        onConsumeShareAgentTargets={() => setTargets(null)}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><ActivityRoot /></ErrorBoundary>, root);
