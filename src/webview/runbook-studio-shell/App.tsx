import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { StudioTombstone } from "../shared/studio/StudioTombstone";
import { StudioLoadError } from "../shared/studio/StudioLoadError";
import { readTombstoneMessage, type StudioTombstoneInfo } from "../shared/studio/tombstone";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Chip, Input, Textarea } from "../shared/ui";
import { blankRunbookFields, computeRunbookDirty, runbookStudioTitleFor, type RunbookStudioReferenceData } from "./domain";
import { cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { RunbookStudioEntity, RunbookStudioFields, RunbookStudioHostMessage } from "./types";

/**
 * t-610705 (SDD 410 Phase D, D1a) — Control-hosted, same props-driven split as Command/Terminal
 * Studio (command-studio-shell/App.tsx's doc comment has the full rationale). Runbook additionally
 * handles the "referenceData" core message on its own — pushed independently of a full `load` after
 * an external command-catalog change (standalone `refreshReferenceData()`; the retired Control host
 * called this `refreshCockpitStudioReferenceData` in studioHost.ts), so the step-resolution chips
 * stay current without disturbing the in-progress edit.
 */
export interface RunbookStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
  /** t-bf3498 — the route's "← Parent" back-link, rendered under the studio title. */
  backLink?: ComponentChildren;
}

const emptyReferenceData = (): RunbookStudioReferenceData => ({ commandNames: [] });
const stepResolutionsFor = (raw: string, commandNames: string[]): Array<{ step: string; ref: boolean }> =>
  raw.split("\n").map((l) => l.trim()).filter(Boolean).map((step) => ({ step, ref: commandNames.includes(step) }));

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: RunbookStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<RunbookStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<RunbookStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<RunbookStudioFields>(blankRunbookFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  // t-b643ac — "the entity this document edits no longer exists" is a DOCUMENT STATE, held apart
  // from `hostError` because they are different facts: an error is something the form recovers
  // from, this is the form having no subject left. Conflating them is what kept a removed agent's
  // whole editor mounted under a red line, with Save one keystroke from clickable.
  const [tombstone, setTombstone] = useState<StudioTombstoneInfo | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<RunbookStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);

  const dirty = computeRunbookDirty(entity, fields);
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
    fieldsRef.current = blankRunbookFields();
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
    const decoded = decodeStudioMessage<RunbookStudioHostMessage>(incoming.message, []);
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
      dirtyRef.current = computeRunbookDirty(d.entity, d.entity.fields);
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
        dirtyRef.current = computeRunbookDirty(entityRef.current, d.snapshot.patch);
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

  if (!ready) {
    return (
      <>
        {backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}
        <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Runbook Studio...</div></div>
      </>
    );
  }

  // t-f4e186 — the host ANSWERED, and the answer carried no document. "Ready with no entity" and
  // "not ready yet" were the same branch above, which is why an `error` with no prior `load` left
  // this surface saying "Loading…" with no second answer coming. Split, they are what they are:
  // once the host has spoken, still-loading is not one of the things this screen may claim.
  if (!entity) {
    return (
      <StudioLoadError
        entityType="runbook"
        error={hostError}
        backLink={backLink}
        onClose={() => post(cancelMessage())}
      />
    );
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight: saving, concurrencyStale: false });
  const updateFields = (updater: (fields: RunbookStudioFields) => RunbookStudioFields) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setLoadFailed(false);
    const next = updater(fieldsRef.current);
    fieldsRef.current = next;
    dirtyRef.current = computeRunbookDirty(entityRef.current, next);
    setFields(next);
  };
  const set = <K extends keyof RunbookStudioFields>(key: K, value: RunbookStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const resolutions = stepResolutionsFor(fields.steps, referenceData.commandNames);

  const onSave = () => {
    if (frozenRef.current) return;
    freezeForSave();
    post(saveMessage());
  };

  return (
    <StudioFrame
      title={runbookStudioTitleFor(mode, entityId, entity)}
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
