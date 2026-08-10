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
import { Button, Chip, Input } from "../shared/ui";
import { blankTerminalFields, computeTerminalDirty, terminalStudioTitleFor, type TerminalStudioReferenceData } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { TerminalStudioEntity, TerminalStudioFields, TerminalStudioHostMessage } from "./types";

/**
 * t-610705 (SDD 410 Phase D, D1a) — Control-hosted, same props-driven split D0 established for
 * Command Studio (command-studio-shell/App.tsx's doc comment has the full rationale: routeKey/
 * mountNonce mount handshake, eager ref updates for the synchronous freeze checkpoint, useStudioFreeze
 * for the nav-transaction freeze). Nothing here is Terminal-specific except the field UI and the
 * domain compute functions — the generic machinery is a straight port.
 *
 * t-b54ead — there is deliberately NO "Git worktree isolation" section here, and re-adding one is a
 * regression rather than a feature. `worktree`, `branch`, and `worktreeSetup` are agent-only by
 * consumption, so `parseAgentEntry` refuses all three under `terminals:` — and `Workspace.mutateConfig`
 * refuses to write a config the loader would discard from, which made Save fail with a message pointing
 * at Agent Studio. The section arrived on 2026-07-06 (`aa99c066`) by mirroring Agent Studio's footer-void
 * LAYOUT fix (t-a1ba6c) and taking its fields along; the parser refusals landed later, in SDD 478 M6.
 * The invariant is measured in `test/unit/terminalStudioAgentOnlyKeys.test.ts` against the loader itself.
 */
export interface TerminalStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
  /** t-bf3498 — the route's "← Parent" back-link, rendered under the studio title. */
  backLink?: ComponentChildren;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const emptyReferenceData = (): TerminalStudioReferenceData => ({ flagMap: {}, defaultCwd: "" });

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: TerminalStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<TerminalStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<TerminalStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<TerminalStudioFields>(blankTerminalFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  // t-b643ac — "the entity this document edits no longer exists" is a DOCUMENT STATE, held apart
  // from `hostError` because they are different facts: an error is something the form recovers
  // from, this is the form having no subject left. Conflating them is what kept a removed agent's
  // whole editor mounted under a red line, with Save one keystroke from clickable.
  const [tombstone, setTombstone] = useState<StudioTombstoneInfo | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<TerminalStudioEntity | undefined>(undefined);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);

  const dirty = computeTerminalDirty(entity, fields);
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
    fieldsRef.current = blankTerminalFields();
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
    const decoded = decodeStudioMessage<TerminalStudioHostMessage>(incoming.message, ["cwd"]);
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
      dirtyRef.current = computeTerminalDirty(d.entity, d.entity.fields);
      setFields(d.entity.fields);
      setMode(d.entity.name === undefined ? "new" : "edit");
      setEntityId(d.entity.name);
      setHostError(undefined);
      setLoadFailed(false);
      setReady(true);
    } else if (d.type === "referenceData") {
      // t-610705 (Phase D, D1a code-review finding) — reference-data refresh is generic over every
      // StudioId, not gated to Runbook/Schedule specifically (the retired Control host's
      // refreshStudioReferenceData fan-out; standalone panels use refreshReferenceData). An external
      // tachyon.yml change while a Terminal Studio is open pushes this here too. Without this branch
      // it fell through to a silent no-op, leaving flagMap/defaultCwd stale until
      // the next full load — never a crash, but a real staleness regression vs the prior panel host
      // (which had no live-refresh trigger of its own, but also never lost one once Runbook/Schedule
      // started sharing the same generic fan-out).
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
        dirtyRef.current = computeTerminalDirty(entityRef.current, d.snapshot.patch);
        setFields(d.snapshot.patch);
      }
    } else if (d.type === "cwd") {
      setHostError(undefined);
      setLoadFailed(false);
      const next = { ...fieldsRef.current, cwd: d.value };
      fieldsRef.current = next;
      dirtyRef.current = computeTerminalDirty(entityRef.current, next);
      setFields(next);
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
        <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Terminal Studio...</div></div>
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
        title={terminalStudioTitleFor(mode, entityId, entity)}
        error={hostError}
        backLink={backLink}
        onClose={() => post(cancelMessage())}
      />
    );
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight: saving, concurrencyStale: false });
  const updateFields = (updater: (fields: TerminalStudioFields) => TerminalStudioFields) => {
    if (frozenRef.current) return;
    setHostError(undefined);
    setLoadFailed(false);
    const next = updater(fieldsRef.current);
    fieldsRef.current = next;
    dirtyRef.current = computeTerminalDirty(entityRef.current, next);
    setFields(next);
  };
  const set = <K extends keyof TerminalStudioFields>(key: K, value: TerminalStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const flags = referenceData.flagMap[firstToken(fields.cmd)] ?? [];

  const onSave = () => {
    if (frozenRef.current) return;
    freezeForSave();
    post(saveMessage());
  };

  return (
    <StudioFrame
      title={terminalStudioTitleFor(mode, entityId, entity)}
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
          <div class="tsh-fields">
            <div class="tsh-grid tsh-grid-compact">
              <div class="tsh-field">
                <label class="tsh-label" for="tsh-name">Name</label>
                <Input id="tsh-name" value={fields.name} placeholder="dev, build, db..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
              </div>
              <div class="tsh-field">
                <label class="tsh-label" for="tsh-watch">Watch files</label>
                <Input id="tsh-watch" value={fields.watch} placeholder="src/**, package.json" onInput={(e) => set("watch", (e.currentTarget as HTMLInputElement).value)} />
                <div class="hint">Comma-separated globs restart this terminal when matching files change.</div>
              </div>
            </div>

            <div class="tsh-group">
              <label class="tsh-label" for="tsh-cmd">Command</label>
              <Input id="tsh-cmd" value={fields.cmd} placeholder="npm run dev · docker compose up · bash" onInput={(e) => set("cmd", (e.currentTarget as HTMLInputElement).value)} />
              <div class="tsh-chips">
                {flags.map((flag) => (
                  <Chip key={flag} active={fields.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>
                ))}
              </div>
            </div>

            <div class="tsh-group">
              <label class="tsh-label" for="tsh-cwd">Working directory</label>
              <div class="tsh-row">
                <Input id="tsh-cwd" value={fields.cwd} placeholder={`(workspace root: ${referenceData.defaultCwd})`} onInput={(e) => set("cwd", (e.currentTarget as HTMLInputElement).value)} />
                <Button onClick={() => post(browseMessage())}>Browse</Button>
              </div>
            </div>

            <div class="tsh-check-grid">
              <label><input type="checkbox" checked={fields.autostart} onChange={(e) => set("autostart", (e.currentTarget as HTMLInputElement).checked)} /> Auto-start</label>
              <label><input type="checkbox" checked={fields.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.currentTarget as HTMLInputElement).checked)} /> Restart on crash</label>
              <label><input type="checkbox" checked={fields.attention} onChange={(e) => set("attention", (e.currentTarget as HTMLInputElement).checked)} /> Attention detection</label>
            </div>
          </div>
        ),
      }}
    />
  );
}
