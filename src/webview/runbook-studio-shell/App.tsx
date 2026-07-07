import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Chip, Input, Textarea } from "../shared/ui";
import { blankRunbookFields, computeRunbookDirty, runbookStudioTitleFor, type RunbookStudioReferenceData } from "./domain";
import { cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { RunbookStudioEntity, RunbookStudioFields, RunbookStudioHostMessage } from "./types";

export interface RunbookStudioDispatch {
  post(msg: unknown): void;
}

const emptyReferenceData = (): RunbookStudioReferenceData => ({ commandNames: [] });
const stepResolutionsFor = (raw: string, commandNames: string[]): Array<{ step: string; ref: boolean }> =>
  raw.split("\n").map((l) => l.trim()).filter(Boolean).map((step) => ({ step, ref: commandNames.includes(step) }));

export function App({ dispatch }: { dispatch: RunbookStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<RunbookStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<RunbookStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<RunbookStudioFields>(blankRunbookFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<RunbookStudioEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<RunbookStudioHostMessage>(e.data, []);
      if (!decoded.ok || !decoded.message) {
        setHostError({
          code: "transport/protocol",
          message: `studio protocol: ${decoded.reason ?? "undecodable message"}`,
          source: "transport",
          blocking: true,
        });
        if (!entityRef.current) setLoadFailed(true);
        setSaveInFlight(false);
        setReady(true);
        return;
      }
      const d = decoded.message;
      if (d.type === "load") {
        entityRef.current = d.entity;
        setEntity(d.entity);
        setReferenceData(d.referenceData ?? emptyReferenceData());
        setFields(d.entity.fields);
        setMode(d.entity.name === undefined ? "new" : "edit");
        setEntityId(d.entity.name);
        setSaveInFlight(!!d.saveInFlight);
        setHostError(undefined);
        setLoadFailed(false);
        setReady(true);
      } else if (d.type === "referenceData") {
        setReferenceData(d.referenceData ?? emptyReferenceData());
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
        if (!entityRef.current) setLoadFailed(true);
        setSaveInFlight(false);
        setReady(true);
      } else if (d.type === "restore") {
        if (d.snapshot?.patch) setFields(d.snapshot.patch);
      }
    };
    window.addEventListener("message", onMsg);
    dispatch.post(readyMessage());
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = computeRunbookDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Runbook Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const updateFields = (updater: (fields: RunbookStudioFields) => RunbookStudioFields) => {
    setHostError(undefined);
    setLoadFailed(false);
    setFields(updater);
  };
  const set = <K extends keyof RunbookStudioFields>(key: K, value: RunbookStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const resolutions = stepResolutionsFor(fields.steps, referenceData.commandNames);

  return (
    <StudioFrame
      title={runbookStudioTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
      regions={{
        fields: (
          <div class="rbsh-fields">
            <div class="rbsh-field">
              <label class="rbsh-label" for="rbsh-name">Name</label>
              <Input id="rbsh-name" value={fields.name} placeholder="ship, deploy, release..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
            </div>

            <div class="rbsh-group">
              <label class="rbsh-label" for="rbsh-steps">Steps</label>
              <Textarea id="rbsh-steps" rows={12} value={fields.steps} placeholder={"lint\ntest\n./deploy.sh"} onInput={(e) => set("steps", (e.currentTarget as HTMLTextAreaElement).value)} />
              <div class="hint">A line matching a command name references it; anything else runs as inline shell.</div>
            </div>

            <div class="rbsh-group">
              <div class="rbsh-label">Resolution</div>
              <div class="rbsh-resolution">
                {resolutions.length === 0 ? (
                  <span class="hint">No steps yet.</span>
                ) : resolutions.map((r, i) => (
                  <div class="rbsh-step" key={`${r.step}-${i}`}>
                    <span class="rbsh-step-text">{r.step}</span>
                    <Chip active={r.ref}>{r.ref ? "command" : "inline shell"}</Chip>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ),
      }}
    />
  );
}
