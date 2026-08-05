import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { StudioTombstone } from "../shared/studio/StudioTombstone";
import { readTombstoneMessage, type StudioTombstoneInfo } from "../shared/studio/tombstone";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Chip, Input, Select, Textarea } from "../shared/ui";
import { blankScheduleFields, computeScheduleDirty, scheduleStudioTitleFor, type ScheduleStudioReferenceData } from "./domain";
import { cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { ScheduleStudioEntity, ScheduleStudioFields, ScheduleStudioHostMessage } from "./types";

/**
 * t-610705 (SDD 410 Phase D, D1a) — Control-hosted, same props-driven split as Command/Terminal/
 * Runbook Studio (command-studio-shell/App.tsx's doc comment has the full rationale). Schedule also
 * handles "referenceData" independently of `load`, same reasoning as Runbook — the command/runbook/
 * agent-name catalog stays current after an external tachyon.yml change.
 */
export interface ScheduleStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
  /** t-bf3498 — the route's "← Parent" back-link, rendered under the studio title. */
  backLink?: ComponentChildren;
}

const emptyReferenceData = (): ScheduleStudioReferenceData => ({ commandNames: [], runbookNames: [], agentNames: [] });

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: ScheduleStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<ScheduleStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<ScheduleStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<ScheduleStudioFields>(blankScheduleFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  // t-b643ac — "the entity this document edits no longer exists" is a DOCUMENT STATE, held apart
  // from `hostError` because they are different facts: an error is something the form recovers
  // from, this is the form having no subject left. Conflating them is what kept a removed agent's
  // whole editor mounted under a red line, with Save one keystroke from clickable.
  const [tombstone, setTombstone] = useState<StudioTombstoneInfo | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<ScheduleStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);

  const dirty = computeScheduleDirty(entity, fields);
  dirtyRef.current = dirty;

  const post = (msg: object): void => dispatch.post({ ...msg, routeKey, mountNonce });

  const { frozen, saving, frozenRef, freezeForSave } = useStudioFreeze({
    post: dispatch.post,
    getSnapshot: () => ({ dirty: dirtyRef.current, editRevision: editRevisionRef.current, patch: dirtyRef.current ? fieldsRef.current : undefined }),
  });

  useEffect(() => {
    setMode("new");
    setEntityId(undefined);
    setEntity(undefined);
    entityRef.current = undefined;
    setReferenceData(emptyReferenceData());
    fieldsRef.current = blankScheduleFields();
    dirtyRef.current = false;
    setFields(fieldsRef.current);
    setHostError(undefined);
    setLoadFailed(false);
    setTombstone(undefined);
    setReady(false);
    dispatch.post(readyMessage({ routeKey, mountNonce }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, mountNonce]);

  useEffect(() => {
    if (!incoming) return;
    const decoded = decodeStudioMessage<ScheduleStudioHostMessage>(incoming.message, []);
    if (!decoded.ok || !decoded.message) {
      setHostError({
        code: "transport/protocol",
        message: `studio protocol: ${decoded.reason ?? "undecodable message"}`,
        source: "transport",
        blocking: true,
      });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
      return;
    }
    const d = decoded.message;
    if (d.type === "load") {
      entityRef.current = d.entity;
      setEntity(d.entity);
      setReferenceData(d.referenceData ?? emptyReferenceData());
      fieldsRef.current = d.entity.fields;
      dirtyRef.current = computeScheduleDirty(d.entity, d.entity.fields);
      setFields(d.entity.fields);
      setMode(d.entity.name === undefined ? "new" : "edit");
      setEntityId(d.entity.name);
      setHostError(undefined);
      setLoadFailed(false);
      setReady(true);
    } else if (d.type === "referenceData") {
      setReferenceData(d.referenceData ?? emptyReferenceData());
    } else if (d.type === "tombstone") {
      setTombstone(readTombstoneMessage(d));
      setHostError(undefined);
      setLoadFailed(false);
      setReady(true);
    } else if (d.type === "error") {
      setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
    } else if (d.type === "restore") {
      if (d.snapshot?.patch) {
        fieldsRef.current = d.snapshot.patch;
        dirtyRef.current = computeScheduleDirty(entityRef.current, d.snapshot.patch);
        setFields(d.snapshot.patch);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  useEffect(() => {
    if (!ready || frozen || tombstone) return;
    editRevisionRef.current += 1;
    post(dirtyMessage(dirty));
    post(patchMessage(fields, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields, frozen]);

  // t-b643ac — decision 4, client half: the tombstone REPLACES the frame rather than banner-ing
  // above it, so Save/Cancel and every adapter action are ABSENT from the DOM instead of disabled
  // in it. Ahead of the loading check on purpose — a tab revived onto an entity that was removed
  // while the window was closed never receives an `entity`, and would otherwise load forever.
  if (tombstone) {
    return <StudioTombstone info={tombstone} backLink={backLink} onClose={() => post(cancelMessage())} />;
  }

  if (!ready || !entity) {
    return (
      <>
        {backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}
        <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Schedule Studio...</div></div>
      </>
    );
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight: saving, concurrencyStale: false });
  const updateFields = (updater: (fields: ScheduleStudioFields) => ScheduleStudioFields) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setLoadFailed(false);
    const next = updater(fieldsRef.current);
    fieldsRef.current = next;
    dirtyRef.current = computeScheduleDirty(entityRef.current, next);
    setFields(next);
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

  const onSave = () => {
    if (frozenRef.current) return;
    freezeForSave();
    post(saveMessage());
  };

  return (
    <StudioFrame
      title={scheduleStudioTitleFor(mode, entityId, entity)}
      backLink={backLink}
      errors={errors}
      dirty={dirty}
      saveInFlight={saving}
      loadFailed={loadFailed}
      canSave={canSave}
      frozen={frozen}
      onSave={onSave}
      onCancel={() => post(cancelMessage())}
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
