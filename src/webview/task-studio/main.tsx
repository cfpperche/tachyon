import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import type { RichDocAttachmentVM } from "../rich-doc/types";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { envelope } from "../shared/studio/protocol";
import { readyMessage, type TaskStudioHostMessage } from "./messages";
import type { TaskDetailEntity } from "./domain";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [entity, setEntity] = useState<TaskDetailEntity | undefined>(undefined);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [hostConflict, setHostConflict] = useState<string | undefined>(undefined);
  const entityRef = useRef<TaskDetailEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as TaskStudioHostMessage | undefined;
      if (!d) return;
      if (d.type === "load") {
        entityRef.current = d.entity;
        setEntity(d.entity);
        setSaveInFlight(!!d.saveInFlight);
        setLoadFailed(false);
        setHostError(undefined);
      } else if (d.type === "error") {
        // a CAS conflict (spec 350 T1's `task/precondition-failed`) gets its own banner (with Reload
        // latest/Export local draft) — every other error rides the shell's generic StudioError shape.
        if (d.code === "task/precondition-failed") { setHostConflict(d.message); return; }
        setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
        if (!entityRef.current) setLoadFailed(true);
      } else if (d.type === "attachmentStored") {
        (window as unknown as { __tachyonTaskStored?: (att: RichDocAttachmentVM) => void }).__tachyonTaskStored?.(d.attachment);
      }
    };
    window.addEventListener("message", onMsg);
    // spec 350 note: shared/ready.ts's readyMessage() predates the studio protocol and carries no
    // studioProtocolVersion — decodeStudioMessage would reject it unwrapped, so envelope() it here rather
    // than editing the shared helper (used by ~10 unrelated non-studio webviews).
    if (vscode) vscode.postMessage(envelope(readyMessage()));
    else window.postMessage(envelope(readyMessage()), "*");
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <App
      entity={entity}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      hostError={hostError}
      hostConflict={hostConflict}
      dispatch={{ post: (msg) => (vscode ? vscode.postMessage(msg) : window.postMessage(msg, "*")) }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
