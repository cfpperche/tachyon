import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import type { PinStudioAttachmentVM } from "./types";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { envelope } from "../shared/studio/protocol";
import { readyMessage, type PinStudioHostMessage } from "./messages";
import type { PinDetailEntity } from "./domain";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function Root() {
  const [entity, setEntity] = useState<PinDetailEntity | undefined>(undefined);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const entityRef = useRef<PinDetailEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as PinStudioHostMessage | undefined;
      if (!d) return;
      if (d.type === "load") {
        entityRef.current = d.entity;
        setEntity(d.entity);
        setSaveInFlight(!!d.saveInFlight);
        setLoadFailed(false);
        setHostError(undefined);
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
        if (!entityRef.current) setLoadFailed(true);
      } else if (d.type === "attachmentStored") {
        (window as unknown as { __tachyonPinStored?: (att: PinStudioAttachmentVM) => void }).__tachyonPinStored?.(d.attachment);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(envelope(readyMessage()));
    else window.postMessage(envelope(readyMessage()), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  return (
    <App
      entity={entity}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      hostError={hostError}
      dispatch={{ post: (msg) => (vscode ? vscode.postMessage(msg) : window.postMessage(msg, "*")) }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
