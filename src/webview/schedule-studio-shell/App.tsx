import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Chip, Input, Select, Textarea } from "../shared/ui";
import { blankScheduleFields, computeScheduleDirty, scheduleStudioTitleFor, type ScheduleStudioReferenceData } from "./domain";
import { cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioHostMessage } from "./types";

export interface ScheduleStudioDispatch {
  post(msg: unknown): void;
}

const emptyReferenceData = (): ScheduleStudioReferenceData => ({ commandNames: [], runbookNames: [], agentNames: [] });

export function App({ dispatch }: { dispatch: ScheduleStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<ScheduleStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<ScheduleStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<ScheduleStudioFields>(blankScheduleFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<ScheduleStudioEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<ScheduleStudioHostMessage>(e.data, []);
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

  const dirty = computeScheduleDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Schedule Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const updateFields = (updater: (fields: ScheduleStudioFields) => ScheduleStudioFields) => {
    setHostError(undefined);
    setLoadFailed(false);
    setFields(updater);
  };
  const set = <K extends keyof ScheduleStudioFields>(key: K, value: ScheduleStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const targets = fields.schedAction === "spawn" ? referenceData.agentNames : [...referenceData.commandNames, ...referenceData.runbookNames];
  const targetKind = fields.schedAction === "spawn"
    ? "agent"
    : referenceData.commandNames.includes(fields.schedTarget)
      ? "command"
      : referenceData.runbookNames.includes(fields.schedTarget)
        ? "runbook"
        : "unknown";

  return (
    <StudioFrame
      title={scheduleStudioTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
      regions={{
        fields: (
          <div class="ssh-fields">
            <div class="ssh-field">
              <label class="ssh-label" for="ssh-name">Name</label>
              <Input id="ssh-name" value={fields.name} placeholder="hourly-tests, standup..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
            </div>

            <div class="ssh-grid ssh-grid-compact">
              <div class="ssh-group">
                <label class="ssh-label" for="ssh-timing">When</label>
                <Select id="ssh-timing" value={fields.schedTiming} onChange={(e) => set("schedTiming", (e.currentTarget as HTMLSelectElement).value as ScheduleStudioFields["schedTiming"])}>
                  <option value="every">Every interval</option>
                  <option value="at">Daily at time</option>
                </Select>
              </div>
              <div class="ssh-group">
                <label class="ssh-label" for="ssh-time-value">{fields.schedTiming === "every" ? "Interval" : "Time"}</label>
                <Input
                  id="ssh-time-value"
                  value={fields.schedTiming === "every" ? fields.schedEvery : fields.schedAt}
                  placeholder={fields.schedTiming === "every" ? "1h, 30m, 2h" : "09:00"}
                  onInput={(e) => set(fields.schedTiming === "every" ? "schedEvery" : "schedAt", (e.currentTarget as HTMLInputElement).value)}
                />
              </div>
            </div>

            <div class="ssh-grid ssh-grid-compact">
              <div class="ssh-group">
                <label class="ssh-label" for="ssh-action">Action</label>
                <Select id="ssh-action" value={fields.schedAction} onChange={(e) => set("schedAction", (e.currentTarget as HTMLSelectElement).value as ScheduleStudioFields["schedAction"])}>
                  <option value="run">Run command or runbook</option>
                  <option value="spawn">Spawn agent</option>
                </Select>
              </div>
              <div class="ssh-group">
                <label class="ssh-label" for="ssh-target">Target</label>
                <Input id="ssh-target" value={fields.schedTarget} list="ssh-targets" placeholder={fields.schedAction === "spawn" ? "agent name" : "command or runbook name"} onInput={(e) => set("schedTarget", (e.currentTarget as HTMLInputElement).value)} />
                <datalist id="ssh-targets">{targets.map((name) => <option key={name} value={name} />)}</datalist>
              </div>
            </div>

            <div class="ssh-group">
              <div class="ssh-label">Target Catalog</div>
              <div class="ssh-chips">
                {targets.length === 0 ? <span class="hint">No targets declared yet.</span> : targets.map((name) => <Chip key={name} active={name === fields.schedTarget} onClick={() => set("schedTarget", name)}>{name}</Chip>)}
              </div>
              {fields.schedTarget.trim().length > 0 && <div class="hint">Current target resolves as {targetKind}.</div>}
            </div>

            {fields.schedTiming === "at" && (
              <label class="ssh-check">
                <input type="checkbox" checked={fields.catchUp} onChange={(e) => set("catchUp", (e.currentTarget as HTMLInputElement).checked)} />
                Catch up once if today's time already passed when the workspace opens
              </label>
            )}

            {fields.schedAction === "spawn" && (
              <div class="ssh-group">
                <label class="ssh-label" for="ssh-instructions">Instructions</label>
                <Textarea id="ssh-instructions" rows={5} value={fields.instructions} placeholder="Optional prompt delivered when the agent starts or is already running." onInput={(e) => set("instructions", (e.currentTarget as HTMLTextAreaElement).value)} />
              </div>
            )}
          </div>
        ),
      }}
    />
  );
}
