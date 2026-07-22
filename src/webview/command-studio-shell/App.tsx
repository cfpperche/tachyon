import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input } from "../shared/ui";
import { blankCommandFields, computeCommandDirty, commandStudioTitleFor, type CommandStudioReferenceData } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { CommandStudioEntity, CommandStudioFields, CommandStudioHostMessage } from "./types";

export interface CommandStudioDispatch {
  post(msg: unknown): void;
}

/**
 * t-610705 (SDD 410 Phase D, D0) — Control-hosted now: props-driven (cockpit/main.tsx's single
 * message listener forwards studio-envelope messages down), same split as every other migrated
 * surface (Activity/TaskDetail/Handoff/...). The "ready" mount handshake needs the CURRENT binding's
 * identity (studioHost.ts's round-2 F3 fix) — `routeKey`/`mountNonce` change whenever the host
 * starts a fresh binding (a different command, or a same-route re-entry after a navigate-away);
 * this component re-sends "ready" whenever that identity changes.
 */
export interface CommandStudioAppProps {
  dispatch: CommandStudioDispatch;
  routeKey: string;
  mountNonce: string;
  /** the latest STUDIO-ENVELOPE message this mount should react to (load/error/restore/cwd/save) —
   *  a NEW `seq` on every arrival (even a repeat shape), so effects keyed on it never miss one.
   *  Nav-transaction freeze messages (studioNavCheckpoint/Abort, studioSaveBegin/End) do NOT arrive
   *  here — see studioFreezeBus.ts for why they need a synchronous, non-React delivery path. */
  incoming?: { seq: number; message: unknown };
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const emptyReferenceData = (): CommandStudioReferenceData => ({ flagMap: {}, defaultCwd: "", verifyCandidates: [] });

export function App({ dispatch, routeKey, mountNonce, incoming }: CommandStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<CommandStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<CommandStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<CommandStudioFields>(blankCommandFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<CommandStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);

  const dirty = computeCommandDirty(entity, fields);
  dirtyRef.current = dirty;

  // t-610705 (Phase D, D0, round-5 blocker) — EVERY message this mount posts carries its CURRENT
  // routeKey/mountNonce, not just "ready" — studioHost.ts now validates identity on every
  // binding-scoped message, so a message this component sent for an OLDER binding (queued, still in
  // flight when the route changed) is recognizably stale and silently ignored host-side instead of
  // mutating whatever binding replaced it.
  const post = (msg: object): void => dispatch.post({ ...msg, routeKey, mountNonce });

  // t-610705 (Phase D, D0, round-3) — the navigation-transaction checkpoint freeze (studioHost.ts's
  // module doc / useStudioFreeze.ts / studioFreezeBus.ts). `getSnapshot` reads the SAME refs the
  // dirty/patch effect below writes, so a checkpoint arriving between renders still reports the
  // truly-latest committed fields — and `frozenRef` (checked by `set()` below) blocks any FURTHER
  // edit synchronously, before this component even re-renders.
  const { frozen, saving, frozenRef, freezeForSave } = useStudioFreeze({
    post: dispatch.post,
    getSnapshot: () => ({ dirty: dirtyRef.current, editRevision: editRevisionRef.current, patch: dirtyRef.current ? fieldsRef.current : undefined }),
  });

  // Re-handshake whenever the binding identity changes (fresh mount OR a same-route re-entry the
  // host rebound) — resets local state so a stale entity never lingers across bindings.
  useEffect(() => {
    setMode("new");
    setEntityId(undefined);
    setEntity(undefined);
    entityRef.current = undefined;
    setReferenceData(emptyReferenceData());
    fieldsRef.current = blankCommandFields();
    dirtyRef.current = false;
    setFields(fieldsRef.current);
    setHostError(undefined);
    setLoadFailed(false);
    setReady(false);
    dispatch.post(readyMessage({ routeKey, mountNonce }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, mountNonce]);

  useEffect(() => {
    // t-610705 (Phase D, D0, round-3) — `incoming` carries ONLY studio-envelope messages now
    // (load/error/restore/cwd/save); the nav-transaction freeze messages (studioNavCheckpoint/
    // studioNavAbort/studioSaveBegin/studioSaveEnd) route through studioFreezeBus synchronously
    // instead (cockpit/main.tsx never puts them in `incoming`) — so every message reaching here IS
    // expected to decode as a real studio-envelope message; a decode failure is a genuine error.
    if (!incoming) return;
    const decoded = decodeStudioMessage<CommandStudioHostMessage>(incoming.message, ["cwd"]);
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
      dirtyRef.current = computeCommandDirty(d.entity, d.entity.fields);
      setFields(d.entity.fields);
      setMode(d.entity.name === undefined ? "new" : "edit");
      setEntityId(d.entity.name);
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
        dirtyRef.current = computeCommandDirty(entityRef.current, d.snapshot.patch);
        setFields(d.snapshot.patch);
      }
    } else if (d.type === "cwd") {
      setHostError(undefined);
      setLoadFailed(false);
      const next = { ...fieldsRef.current, cwd: d.value };
      fieldsRef.current = next;
      dirtyRef.current = computeCommandDirty(entityRef.current, next);
      setFields(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  useEffect(() => {
    // t-610705 (Phase D, D0) — frozen means a checkpoint is mid-flight: no further patch/dirty
    // posts (nothing could have changed anyway — inputs are pointer-events:none while frozen).
    if (!ready || frozen) return;
    editRevisionRef.current += 1;
    post(dirtyMessage(dirty));
    post(patchMessage(fields, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields, frozen]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Command Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight: saving, concurrencyStale: false });
  // t-610705 (Phase D, D0, round-3) — `frozenRef.current` is the SYNCHRONOUS enforcement gate: any
  // field-update call while frozen is a no-op, checked before touching `fields` at all — this is
  // what actually blocks edits (not the `.sf-body { pointer-events: none }` CSS, which is cosmetic
  // and would race a fast enough keystroke; see studioFreezeBus.ts's module doc for the full case).
  // t-610705 (Phase D, D0, round-4 major) — `fieldsRef`/`dirtyRef` are updated HERE, synchronously,
  // in the SAME callstack as the `onInput` event that triggered this — not left to wait for the
  // next render's top-of-body `fieldsRef.current = fields` assignment. Preact's state-update
  // scheduling is NOT guaranteed to flush before a postMessage-delivered checkpoint's synchronous
  // handler runs (they're independent event-loop sources); without this, `getSnapshot()` could read
  // a ref that's one edit BEHIND what the user just typed, even though `frozenRef.current` correctly
  // blocked anything AFTER the checkpoint. Eagerly updating here closes that gap — by the time
  // `set()` returns, both refs already reflect this edit, render or no render.
  const updateFields = (updater: (fields: CommandStudioFields) => CommandStudioFields) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setLoadFailed(false);
    const next = updater(fieldsRef.current);
    fieldsRef.current = next;
    dirtyRef.current = computeCommandDirty(entityRef.current, next);
    setFields(next);
  };
  const set = <K extends keyof CommandStudioFields>(key: K, value: CommandStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const flags = referenceData.flagMap[firstToken(fields.cmd)] ?? [];

  const onSave = () => {
    if (frozenRef.current) return;
    freezeForSave(); // t-610705 (round-3 blocker #2) — synchronous, optimistic: no round-trip window
    post(saveMessage());
  };

  return (
    <StudioFrame
      title={commandStudioTitleFor(mode, entityId, entity)}
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
          <div class="csh-fields">
            <div class="csh-field">
              <label class="csh-label" for="csh-name">Name</label>
              <Input id="csh-name" value={fields.name} placeholder="test, build, deploy..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
            </div>

            <div class="csh-group">
              <label class="csh-label" for="csh-cmd">Command</label>
              <Input id="csh-cmd" value={fields.cmd} placeholder="npm test · cargo build · ./deploy.sh" onInput={(e) => set("cmd", (e.currentTarget as HTMLInputElement).value)} />
              <div class="csh-chips">
                {flags.map((flag) => (
                  <Chip key={flag} active={fields.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>
                ))}
              </div>
            </div>

            <div class="csh-group">
              <label class="csh-label" for="csh-cwd">Working directory</label>
              <div class="csh-row">
                <Input id="csh-cwd" value={fields.cwd} placeholder={`(workspace root: ${referenceData.defaultCwd})`} onInput={(e) => set("cwd", (e.currentTarget as HTMLInputElement).value)} />
                <Button onClick={() => post(browseMessage())}>Browse</Button>
              </div>
            </div>
          </div>
        ),
      }}
    />
  );
}
