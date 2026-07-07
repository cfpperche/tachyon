import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input } from "../shared/ui";
import { blankCommandFields, computeCommandDirty, commandStudioTitleFor, type CommandStudioReferenceData } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { CommandStudioEntity, CommandStudioFields, CommandStudioHostMessage } from "./types";

export interface CommandStudioDispatch {
  post(msg: unknown): void;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const emptyReferenceData = (): CommandStudioReferenceData => ({ flagMap: {}, defaultCwd: "", verifyCandidates: [] });

export function App({ dispatch }: { dispatch: CommandStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<CommandStudioEntity | undefined>(undefined);
  const [referenceData, setReferenceData] = useState<CommandStudioReferenceData>(emptyReferenceData);
  const [fields, setFields] = useState<CommandStudioFields>(blankCommandFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<CommandStudioEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<CommandStudioHostMessage>(e.data, ["cwd"]);
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

  const dirty = computeCommandDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Command Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const updateFields = (updater: (fields: CommandStudioFields) => CommandStudioFields) => {
    setHostError(undefined);
    setLoadFailed(false);
    setFields(updater);
  };
  const set = <K extends keyof CommandStudioFields>(key: K, value: CommandStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const flags = referenceData.flagMap[firstToken(fields.cmd)] ?? [];

  return (
    <StudioFrame
      title={commandStudioTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
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
                <Button onClick={() => dispatch.post(browseMessage())}>Browse</Button>
              </div>
            </div>
          </div>
        ),
      }}
    />
  );
}
