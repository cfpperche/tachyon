import { useEffect, useState } from "preact/hooks";
import { Button, IconButton } from "../shared/ui";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { studioLoadErrorTitle } from "../shared/studio/studioLoadErrorTitle";
import { computePipelineDirty, pipelineTitleFor, validatePipelineFields } from "./domain";
import type { PipelineEntity, PipelineFields } from "./domain";
import { cancelMessage, dirtyMessage, importStagesMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { PipelineStudioHostMessage } from "./types";

/**
 * spec 350 T4 — Pipeline Studio (Fake 1): a behaviorally-complete but semantics-free studio proving the
 * shell's full lifecycle. Dev-flag-hidden (no command contribution anywhere) — this surface is reachable
 * only through the preview harness and its own unit tests, never a real Tachyon command.
 */

export interface PipelineStudioDispatch {
  post(msg: unknown): void;
}

const EMPTY_FIELDS: PipelineFields = { title: "", stages: [] };

export function App({ dispatch }: { dispatch: PipelineStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<PipelineEntity | undefined>(undefined);
  const [fields, setFields] = useState<PipelineFields>(EMPTY_FIELDS);
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [concurrencyStale, setConcurrencyStale] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [importText, setImportText] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as PipelineStudioHostMessage | undefined;
      if (!d) return;
      if (d.type === "load") {
        setEntity(d.entity);
        setFields({ title: d.entity.title, stages: d.entity.stages });
        setMode(d.entity.id === "new" ? "new" : "edit");
        setEntityId(d.entity.id === "new" ? undefined : d.entity.id);
        setConcurrencyStale(d.concurrency.kind === "cas" && !!d.concurrency.stale);
        setSaveInFlight(!!d.saveInFlight);
        setHostError(undefined);
        setLoadFailed(false);
        setReady(true);
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: "persistence", blocking: d.blocking });
        if (!entity) setLoadFailed(true);
        setReady(true);
      } else if (d.type === "restore") {
        if (d.snapshot?.patch) setFields(d.snapshot.patch);
      } else if (d.type === "stagesImported") {
        setFields((f) => ({ ...f, stages: d.stages }));
        setImportText("");
      }
    };
    window.addEventListener("message", onMsg);
    dispatch.post(readyMessage());
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = computePipelineDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  if (!ready) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Pipeline Studio...</div></div>;
  }

  const validation = validatePipelineFields(fields);
  const errors: StudioError[] = [...(hostError ? [hostError] : []), ...validation.blocking, ...validation.nonBlocking];
  const canSave = computeCanSave({
    dirty,
    blockingErrorCount: validation.blocking.length + (hostError?.blocking ? 1 : 0),
    saveInFlight,
    concurrencyStale,
  });

  const setTitle = (title: string) => setFields((f) => ({ ...f, title }));
  const addStage = () => setFields((f) => ({ ...f, stages: [...f.stages, { id: `stage-${f.stages.length + 1}`, name: "" }] }));
  const renameStage = (id: string, name: string) => setFields((f) => ({ ...f, stages: f.stages.map((s) => (s.id === id ? { ...s, name } : s)) }));
  const removeStage = (id: string) => setFields((f) => ({ ...f, stages: f.stages.filter((s) => s.id !== id) }));

  return (
    <StudioFrame
      // t-831332 — on a failed load the client has no identity; titleFor falls to "New Pipeline".
      // Name the surface instead, same contract StudioLoadError owns for the seven real shells.
      title={loadFailed ? studioLoadErrorTitle("pipeline") : pipelineTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      concurrencyStale={concurrencyStale}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
      regions={{
        fields: (
          <div class="ps-fields">
            <label class="ps-label" for="ps-title">Title</label>
            <input id="ps-title" class="ps-input" value={fields.title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
            <div class="ps-stages">
              <div class="ps-stages-head">Stages</div>
              {fields.stages.map((s) => (
                <div class="ps-stage-row" key={s.id}>
                  <input class="ps-input" value={s.name} placeholder="stage name" onInput={(e) => renameStage(s.id, (e.currentTarget as HTMLInputElement).value)} />
                  <IconButton name="close" class="ps-icon-btn" title={`Remove stage ${s.name || s.id}`} onClick={() => removeStage(s.id)} />
                </div>
              ))}
              <Button onClick={addStage}>+ Add stage</Button>
            </div>
          </div>
        ),
        sideActions: (
          <div class="ps-import">
            <label class="ps-label" for="ps-import-text">Paste stage names (one per line)</label>
            <textarea id="ps-import-text" class="ps-input" value={importText} onInput={(e) => setImportText((e.currentTarget as HTMLTextAreaElement).value)} />
            <Button disabled={!importText.trim()} onClick={() => dispatch.post(importStagesMessage(importText))}>
              Import stages
            </Button>
          </div>
        ),
      }}
    />
  );
}
