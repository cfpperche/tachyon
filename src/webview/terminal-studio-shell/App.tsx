import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Textarea } from "../shared/ui";
import { blankTerminalFields, computeTerminalDirty, terminalStudioTitleFor, type TerminalStudioReferenceData } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { TerminalStudioEntity, TerminalStudioFields, TerminalStudioHostMessage } from "./types";

/**
 * t-610705 (SDD 410 Phase D, D1a) — Control-hosted, same props-driven split D0 established for
 * Command Studio (command-studio-shell/App.tsx's doc comment has the full rationale: routeKey/
 * mountNonce mount handshake, eager ref updates for the synchronous freeze checkpoint, useStudioFreeze
 * for the nav-transaction freeze). Nothing here is Terminal-specific except the field UI and the
 * domain compute functions — the generic machinery is a straight port.
 */
export interface TerminalStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const emptyReferenceData = (): TerminalStudioReferenceData => ({ flagMap: {}, defaultCwd: "", verifyCandidates: [] });

export function App({ dispatch, routeKey, mountNonce, incoming }: TerminalStudioAppProps) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<TerminalStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<TerminalStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<TerminalStudioFields>(blankTerminalFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
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
      // t-610705 (Phase D, D1a code-review finding) — refreshStudioReferenceData (studioHost.ts) is
      // generic over every StudioId, not gated to Runbook/Schedule specifically: an external
      // tachyon.yml change while a Terminal Studio route is active pushes this here too. Without this
      // branch it fell through to a silent no-op, leaving flagMap/defaultCwd/verifyCandidates stale
      // until the next full load — never a crash, but a real staleness regression vs the retired
      // TerminalStudioPanelManager (which had no live-refresh trigger of its own, but also never lost
      // one once Runbook/Schedule started sharing the same generic host fan-out).
      setReferenceData(d.referenceData ?? emptyReferenceData());
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
    if (!ready || frozen) return;
    editRevisionRef.current += 1;
    post(dirtyMessage(dirty));
    post(patchMessage(fields, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields, frozen]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Terminal Studio...</div></div>;
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

            {/* t-a1ba6c — worktree section in main fields column (same footer-void fix as Agent Studio). */}
            <details open={fields.worktree || !!fields.branch || !!fields.worktreeSetup || !!fields.verify}>
              <summary>Git worktree isolation</summary>
              <label class="check"><input type="checkbox" checked={fields.worktree} onChange={(e) => set("worktree", (e.currentTarget as HTMLInputElement).checked)} /> Run in its own git worktree + branch</label>
              <label class="tsh-label" for="tsh-branch">Branch (blank = tachyon/&lt;name&gt;)</label>
              <Input id="tsh-branch" value={fields.branch} placeholder="feature/auth-redesign" onInput={(e) => set("branch", (e.currentTarget as HTMLInputElement).value)} />
              <label class="tsh-label" for="tsh-setup">Setup commands</label>
              <Textarea id="tsh-setup" rows={3} value={fields.worktreeSetup} onInput={(e) => set("worktreeSetup", (e.currentTarget as HTMLTextAreaElement).value)} />
              <label class="tsh-label" for="tsh-verify">Verify gate</label>
              <Input id="tsh-verify" value={fields.verify} placeholder="npm test · a command/runbook name" onInput={(e) => set("verify", (e.currentTarget as HTMLInputElement).value)} />
              <div class="tsh-chips">
                {referenceData.verifyCandidates.map((c) => (
                  <Chip key={c} active={c === fields.verify.trim()} onClick={() => set("verify", c)}>{c}</Chip>
                ))}
              </div>
            </details>
          </div>
        ),
      }}
    />
  );
}
