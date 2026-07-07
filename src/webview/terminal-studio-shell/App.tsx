import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Textarea } from "../shared/ui";
import { blankTerminalFields, computeTerminalDirty, terminalStudioTitleFor, type TerminalStudioReferenceData } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { TerminalStudioEntity, TerminalStudioFields, TerminalStudioHostMessage } from "./types";

export interface TerminalStudioDispatch {
  post(msg: unknown): void;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const emptyReferenceData = (): TerminalStudioReferenceData => ({ flagMap: {}, defaultCwd: "", verifyCandidates: [] });

export function App({ dispatch }: { dispatch: TerminalStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<TerminalStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<TerminalStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<TerminalStudioFields>(blankTerminalFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<TerminalStudioEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<TerminalStudioHostMessage>(e.data, ["cwd"]);
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
        setReferenceData(d.referenceData);
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
        if (!entityRef.current) setLoadFailed(true);
        setSaveInFlight(false);
        setReady(true);
      } else if (d.type === "restore") {
        if (d.snapshot?.patch) setFields(d.snapshot.patch);
      } else if (d.type === "cwd") {
        setHostError(undefined);
        setLoadFailed(false);
        setFields((f) => ({ ...f, cwd: d.value }));
      }
    };
    window.addEventListener("message", onMsg);
    dispatch.post(readyMessage());
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = computeTerminalDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Terminal Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const updateFields = (updater: (fields: TerminalStudioFields) => TerminalStudioFields) => {
    setHostError(undefined);
    setLoadFailed(false);
    setFields(updater);
  };
  const set = <K extends keyof TerminalStudioFields>(key: K, value: TerminalStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const flags = referenceData.flagMap[firstToken(fields.cmd)] ?? [];

  return (
    <StudioFrame
      title={terminalStudioTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
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
                <Button onClick={() => dispatch.post(browseMessage())}>Browse</Button>
              </div>
            </div>

            <div class="tsh-check-grid">
              <label><input type="checkbox" checked={fields.autostart} onChange={(e) => set("autostart", (e.currentTarget as HTMLInputElement).checked)} /> Auto-start</label>
              <label><input type="checkbox" checked={fields.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.currentTarget as HTMLInputElement).checked)} /> Restart on crash</label>
              <label><input type="checkbox" checked={fields.attention} onChange={(e) => set("attention", (e.currentTarget as HTMLInputElement).checked)} /> Attention detection</label>
            </div>
          </div>
        ),
        sideActions: (
          <div class="tsh-side">
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
