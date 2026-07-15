import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Select, Textarea } from "../shared/ui";
import { KitDropdown, KitDropdownContent, KitDropdownItem, KitDropdownSeparator, KitDropdownTrigger, KitFilePicker } from "../shared/ui/kit";
import {
  AGENT_STUDIO_HOST_MESSAGE_NAMES,
  SOUL_IMPORT_MAX_BYTES,
  agentStudioTitleFor,
  blankAgentFields,
  computeAgentDirty,
  isAllowedSoulImportFileName,
  validateAgentStudioHostDomainMessage,
} from "./domain";
import {
  adoptSoulProfileMessage,
  browseMessage,
  cancelMessage,
  createSoulMessage,
  deleteSoulProfileMessage,
  dirtyMessage,
  disableSoulMessage,
  enableSoulMessage,
  importSoulMessage,
  openSoulMessage,
  patchMessage,
  previewSoulMessage,
  readyMessage,
  refreshSoulMessage,
  saveMessage,
} from "./messages";
import { RuntimeLogo } from "./runtimeLogos";
import type { AgentStudioEntity, AgentStudioFields, AgentStudioHostMessage, SoulProfileStatusMessage } from "./types";

/**
 * spec 350 Phase 3 T3 — the Agent-kind studio's webview surface: quick-add chips, name,
 * command + flag chips, role template, instructions, autostart/restart/attention,
 * worktree section, isolated-harness section) rendered inside StudioFrame's fields region (contiguous
 * document flow under Working directory — t-a1ba6c) instead of the old hand-rolled chrome. Faithful port
 * of the fields — same field names, same show/hide rules (harness for claude/codex/opencode/grok/hermes) —
 * just no kind tabs (this studio only ever creates/edits `kind: "agent"`).
 *
 * `firstToken`/`harnessRuntimeOfCmd` are deliberately reimplemented here (not imported from formLogic.ts) —
 * formLogic.ts's runtime
 * exports transitively pull in `node:fs` (via config/loadConfig.ts), which this browser bundle can't resolve
 * (see agent-studio-shell/domain.ts's header for the empirical confirmation).
 */

export interface AgentStudioDispatch {
  post(msg: unknown): void;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
/** Keep in sync with formLogic.harnessRuntimeOf / loadConfig HARNESS_BINS. */
const HARNESS_STUDIO_BINS = new Set(["claude", "codex", "opencode", "grok", "hermes"]);
const harnessRuntimeOfCmd = (cmd: string): string | undefined => {
  const bin = firstToken(cmd);
  return HARNESS_STUDIO_BINS.has(bin) ? bin : undefined;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function SoulImportPicker({ onCancel, onSelect }: {
  onCancel(): void;
  onSelect(contentBase64: string): void;
}) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    if (!isAllowedSoulImportFileName(file.name)) {
      setError("Choose a .md, .markdown, or .txt file.");
      return;
    }
    if (file.size === 0) {
      setError("The selected file is empty.");
      return;
    }
    if (file.size > SOUL_IMPORT_MAX_BYTES) {
      setError("The selected file is larger than 64 KB.");
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0 || bytes.length > SOUL_IMPORT_MAX_BYTES) {
        setError(bytes.length === 0 ? "The selected file is empty." : "The selected file is larger than 64 KB.");
        return;
      }
      onSelect(bytesToBase64(bytes));
    } catch {
      setError("Tachyon could not read the selected file.");
    } finally {
      setReading(false);
    }
  };

  return (
    <KitFilePicker
      title="Import identity file"
      description={<>Markdown or text, up to 64 KB. Tachyon copies the contents into this agent&apos;s managed SOUL.md.</>}
      accept=".md,.markdown,.txt,text/markdown,text/plain"
      disabled={reading}
      error={error}
      draggingLabel="Drop to import"
      cancelLabel="Cancel import"
      onFile={selectFile}
      onCancel={onCancel}
    />
  );
}

export function App({ dispatch }: { dispatch: AgentStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<AgentStudioEntity | undefined>(undefined);
  const [fields, setFields] = useState<AgentStudioFields>(blankAgentFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [soulStatus, setSoulStatus] = useState<SoulProfileStatusMessage | undefined>(undefined);
  const [soulBusy, setSoulBusy] = useState<string | undefined>(undefined);
  const [soulImportOpen, setSoulImportOpen] = useState(false);
  const [soulDeleteConfirmOpen, setSoulDeleteConfirmOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<AgentStudioEntity | undefined>(undefined);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<AgentStudioHostMessage>(e.data, AGENT_STUDIO_HOST_MESSAGE_NAMES);
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
      if (AGENT_STUDIO_HOST_MESSAGE_NAMES.includes(d.type as never) && !validateAgentStudioHostDomainMessage(d)) {
        setHostError({ code: "transport/protocol", message: "studio protocol: malformed Agent Studio host response", source: "transport", blocking: true });
        setSaveInFlight(false);
        setReady(true);
        return;
      }
      if (d.type === "load") {
        entityRef.current = d.entity;
        setEntity(d.entity);
        setFields(d.entity.fields);
        setMode(d.entity.name === undefined ? "new" : "edit");
        setEntityId(d.entity.name);
        setSaveInFlight(!!d.saveInFlight);
        setHostError(undefined);
        setLoadFailed(false);
        setSoulStatus(undefined);
        setSoulBusy(d.entity.name ? "Refreshing profile" : undefined);
        setSoulImportOpen(false);
        setSoulDeleteConfirmOpen(false);
        setReady(true);
        if (d.entity.name) dispatch.post(refreshSoulMessage(d.entity.name));
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
        if (!entityRef.current) setLoadFailed(true);
        setSaveInFlight(false);
        setSoulBusy(undefined);
        setReady(true);
      } else if (d.type === "restore") {
        if (d.snapshot?.patch) setFields(d.snapshot.patch);
      } else if (d.type === "cwd") {
        setHostError(undefined);
        setLoadFailed(false);
        setFields((f) => ({ ...f, cwd: d.value }));
      } else if (d.type === "soulProfileStatus") {
        if (entityRef.current?.name !== d.status.agent) {
          setHostError({ code: "transport/protocol", message: "studio protocol: profile status belongs to another agent", source: "transport", blocking: true });
          return;
        }
        setHostError(undefined);
        setSoulStatus(d.status);
        setSoulBusy(undefined);
        if (d.status.lifecycle !== "missing") setSoulImportOpen(false);
        if (d.status.lifecycle === "missing") setSoulDeleteConfirmOpen(false);
        const current = entityRef.current;
        if (current && current.fields.soul !== d.status.soulEnabled) {
          const updated = { ...current, fields: { ...current.fields, soul: d.status.soulEnabled } };
          entityRef.current = updated;
          setEntity(updated);
        }
        setFields((currentFields) => currentFields.soul === d.status.soulEnabled
          ? currentFields
          : { ...currentFields, soul: d.status.soulEnabled });
      } else if (d.type === "soulProfileError") {
        if (entityRef.current?.name !== d.agent) {
          setHostError({ code: "transport/protocol", message: "studio protocol: profile error belongs to another agent", source: "transport", blocking: true });
          return;
        }
        setSoulBusy(undefined);
        setHostError({ code: d.code, message: d.message, source: "persistence", blocking: false });
      }
    };
    window.addEventListener("message", onMsg);
    dispatch.post(readyMessage());
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = computeAgentDirty(entity, fields);
  useEffect(() => {
    if (!ready) return;
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dirty, fields]);

  useEffect(() => {
    if (soulDeleteConfirmOpen) deleteCancelButtonRef.current?.focus();
  }, [soulDeleteConfirmOpen]);

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Agent Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const updateFields = (updater: (fields: AgentStudioFields) => AgentStudioFields) => {
    setHostError(undefined);
    setLoadFailed(false);
    setFields(updater);
  };
  const set = <K extends keyof AgentStudioFields>(key: K, value: AgentStudioFields[K]) => updateFields((f) => ({ ...f, [key]: value }));
  const toggleFlag = (flag: string) => {
    const cmd = fields.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : (cmd.trim() + " " + flag).trim());
  };
  const pickChip = (bin: string) => {
    let name = fields.name;
    if (!fields.name || mode === "new") {
      let n = bin;
      let i = 2;
      // taken-name uniqueness is re-checked authoritatively at save time (studioSubmit) — this is only a
      // friendly default, so it doesn't need entity reference data beyond avoiding an obvious in-session clash.
      while (n === entityId) n = `${bin}-${i++}`;
      name = n;
    }
    updateFields((f) => ({ ...f, cmd: bin, name }));
  };

  const flags = entity.flagMap[firstToken(fields.cmd)] ?? [];
  const harnessRuntime = harnessRuntimeOfCmd(fields.cmd);
  const showHarness = !!harnessRuntime;
  const showHarnessRules = harnessRuntime === "claude";
  const showHarnessInstructions = harnessRuntime === "codex";
  const harnessCheckboxLabel =
    harnessRuntime === "codex"
      ? "Give this Codex agent its own config, skills, hooks, and MCP"
      : harnessRuntime === "grok"
        ? "Give this Grok agent its own GROK_HOME (config, skills, hooks, MCP)"
        : harnessRuntime === "hermes"
          ? "Give this Hermes agent its own HERMES_HOME (config, skills, hooks, MCP)"
          : harnessRuntime === "opencode"
            ? "Give this OpenCode agent its own XDG home (config, skills, hooks, MCP)"
            : "Give this agent its own MCP / skills / rules / hooks";

  const savedAgent = entity.name;
  const profilePresent = !!soulStatus && soulStatus.lifecycle !== "missing";
  const profileReadable = profilePresent && soulStatus?.lifecycle !== "invalid";
  const readActionDisabled = !savedAgent || !!soulBusy;
  const mutationDisabled = readActionDisabled || !soulStatus || soulStatus.transactionDegraded;
  const showCreateOrImport = soulStatus?.lifecycle === "missing";
  const showAdopt = !!soulStatus?.sha256
    && (soulStatus.lifecycle === "retained" || soulStatus.lifecycle === "unowned");
  const showEnable = soulStatus?.lifecycle === "active"
    && soulStatus.resolvable
    && !soulStatus.soulEnabled;
  const showDisable = !!soulStatus?.soulEnabled;
  const showDelete = profilePresent && !soulStatus?.soulEnabled;
  const canCreateOrImport = showCreateOrImport && !mutationDisabled && !soulImportOpen;
  const canAdopt = showAdopt && !mutationDisabled;
  const canEnable = showEnable && !mutationDisabled;
  const canDisable = showDisable && !mutationDisabled;
  const canDelete = showDelete && !mutationDisabled;
  const lifecycleLabel: Record<SoulProfileStatusMessage["lifecycle"], string> = {
    missing: "Missing",
    active: "Active",
    retained: "Retained",
    unowned: "Needs adoption",
    invalid: "Invalid",
  };
  const runSoulAction = (label: string, message: unknown) => {
    setHostError(undefined);
    setSoulImportOpen(false);
    setSoulDeleteConfirmOpen(false);
    setSoulBusy(label);
    dispatch.post(message);
  };

  return (
    <StudioFrame
      title={agentStudioTitleFor(mode, entityId, entity)}
      errors={errors}
      dirty={dirty}
      saveInFlight={saveInFlight}
      loadFailed={loadFailed}
      canSave={canSave}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
      regions={{
        fields: (
          <div class="ash-fields">
            <div class="ash-group">
              <div class="ash-label">Quick add (detected on this machine)</div>
              <div class="ash-chips" role="group" aria-label="Quick add">
                {entity.chips.map((c) => (
                  <Chip key={c.bin} class={c.detected ? "ash-runtime-chip ash-runtime-chip-detected" : "ash-runtime-chip"} active={fields.cmd === c.bin} disabled={!c.detected} onClick={() => c.detected && pickChip(c.bin)} title={c.installHint}>
                    <RuntimeLogo id={c.bin} />
                    {c.label}
                  </Chip>
                ))}
              </div>
            </div>

            <section class="ash-identity" aria-labelledby="ash-identity-title">
              <div class="ash-identity-heading">
                <div>
                  <div class="ash-label" id="ash-identity-title">Identity (SOUL.md)</div>
                  <div class="hint">Stable identity for this agent. Keep operational instructions in the separate field below.</div>
                </div>
                <span class={`ash-soul-state ash-soul-state-${soulStatus?.lifecycle ?? "loading"}`}>
                  {savedAgent
                    ? soulStatus ? lifecycleLabel[soulStatus.lifecycle] : "Loading status"
                    : "Save agent first"}
                </span>
              </div>

              {savedAgent ? (
                <>
                  <div class="ash-identity-actions" role="group" aria-label="SOUL.md actions">
                    {showCreateOrImport && (
                      <>
                        <Button variant="primary" icon="new-file" disabled={!canCreateOrImport} onClick={() => runSoulAction("Creating profile", createSoulMessage(savedAgent))}>Create</Button>
                        <Button icon="folder-opened" disabled={!canCreateOrImport} onClick={() => { setHostError(undefined); setSoulImportOpen(true); }}>Import</Button>
                      </>
                    )}
                    {profilePresent && (
                      <Button icon="go-to-file" disabled={readActionDisabled} onClick={() => runSoulAction("Opening profile", openSoulMessage(savedAgent))}>Edit file</Button>
                    )}
                    {showEnable && (
                      <Button variant="primary" icon="check" disabled={!canEnable} onClick={() => runSoulAction("Enabling soul", enableSoulMessage(savedAgent))}>Enable soul</Button>
                    )}
                    {showDisable && (
                      <Button disabled={!canDisable} onClick={() => runSoulAction("Disabling soul", disableSoulMessage(savedAgent))}>Disable soul</Button>
                    )}
                    {soulStatus && (
                      <KitDropdown>
                        <KitDropdownTrigger asChild>
                          <Button icon="ellipsis" aria-label="More SOUL.md actions">More</Button>
                        </KitDropdownTrigger>
                        <KitDropdownContent align="start">
                          <KitDropdownItem disabled={readActionDisabled} onSelect={() => runSoulAction("Refreshing profile", refreshSoulMessage(savedAgent))}>Refresh</KitDropdownItem>
                          {profileReadable && (
                            <KitDropdownItem disabled={readActionDisabled} onSelect={() => runSoulAction("Loading preview", previewSoulMessage(savedAgent))}>Preview</KitDropdownItem>
                          )}
                          {showAdopt && (
                            <KitDropdownItem disabled={!canAdopt} onSelect={() => runSoulAction("Adopting profile", adoptSoulProfileMessage(savedAgent, soulStatus.sha256!))}>Adopt existing file</KitDropdownItem>
                          )}
                          {showDelete && (
                            <>
                              <KitDropdownSeparator />
                              <KitDropdownItem
                                variant="destructive"
                                disabled={!canDelete}
                                onSelect={() => {
                                  setHostError(undefined);
                                  setSoulImportOpen(false);
                                  setSoulDeleteConfirmOpen(true);
                                }}
                              >Delete identity permanently…</KitDropdownItem>
                            </>
                          )}
                        </KitDropdownContent>
                      </KitDropdown>
                    )}
                  </div>

                  {soulImportOpen && (
                    <SoulImportPicker
                      onCancel={() => setSoulImportOpen(false)}
                      onSelect={(contentBase64) => {
                        setSoulImportOpen(false);
                        runSoulAction("Importing profile", importSoulMessage(savedAgent, contentBase64));
                      }}
                    />
                  )}

                  {soulDeleteConfirmOpen && soulStatus && (
                    <div class="ash-soul-delete-confirm" aria-labelledby="ash-soul-delete-confirm-title">
                      <div class="ash-soul-delete-confirm-title" id="ash-soul-delete-confirm-title">Delete this identity permanently?</div>
                      <div>This removes only the Soul-owned files:</div>
                      <ul>
                        <li><code>{soulStatus.relativePath}</code></li>
                        <li><code>{`.tachyon/agents/${savedAgent}/profile.json`}</code></li>
                      </ul>
                      <div>The agent directory and every other file inside it will remain.</div>
                      <div class="ash-soul-delete-confirm-actions">
                        <Button ref={deleteCancelButtonRef} onClick={() => setSoulDeleteConfirmOpen(false)}>Cancel</Button>
                        <Button
                          variant="danger"
                          icon="trash"
                          disabled={!canDelete}
                          onClick={() => runSoulAction("Deleting identity", deleteSoulProfileMessage(savedAgent))}
                        >Delete identity permanently</Button>
                      </div>
                    </div>
                  )}

                  <div class="ash-soul-status" role="status" aria-live="polite">
                    {soulBusy
                      ? `${soulBusy}…`
                      : soulStatus
                        ? `${lifecycleLabel[soulStatus.lifecycle]} · ${soulStatus.soulEnabled ? "enabled for future starts" : "disabled"}`
                        : "Profile status unavailable. Refresh to try again."}
                  </div>

                  {soulStatus?.transactionDegraded && (
                    <div class="ash-soul-warning" role="alert">Profile recovery is required. Mutating actions are disabled.</div>
                  )}

                  {soulStatus && (
                    <div class="ash-soul-meta">
                      <span>{soulStatus.relativePath}</span>
                      {soulStatus.bytes !== undefined && <span>{soulStatus.bytes} bytes</span>}
                      {soulStatus.sha256 && <span title={soulStatus.sha256}>SHA-256 {soulStatus.sha256.slice(0, 12)}…</span>}
                    </div>
                  )}

                  {soulStatus?.preview !== undefined && (
                    <pre class="ash-soul-preview" aria-label="SOUL.md preview" tabIndex={0}>{soulStatus.preview}</pre>
                  )}
                </>
              ) : (
                <div class="ash-soul-status" role="status">Save this agent before creating or importing its identity profile.</div>
              )}
            </section>

            <div class="ash-grid ash-grid-compact">
              <div class="ash-field">
                <label class="ash-label" for="ash-name">Name</label>
                <Input id="ash-name" value={fields.name} placeholder="frontend, revisor, dev..." onInput={(e) => set("name", (e.currentTarget as HTMLInputElement).value)} />
              </div>

              <div class="ash-field">
                <label class="ash-label" for="ash-role">Role template</label>
                <Select id="ash-role" value={fields.role} onChange={(e) => set("role", (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">(none)</option>
                  <option value="coder">coder</option>
                  <option value="reviewer">reviewer</option>
                  <option value="tester">tester</option>
                  <option value="orchestrator">orchestrator</option>
                  <option value="custom">custom</option>
                </Select>
              </div>
            </div>

            <div class="ash-group">
              <label class="ash-label" for="ash-cmd">Command</label>
              <Input id="ash-cmd" value={fields.cmd} placeholder="claude · codex · agy · npm run dev" onInput={(e) => set("cmd", (e.currentTarget as HTMLInputElement).value)} />
              <div class="ash-chips">
                {flags.map((flag) => (
                  <Chip key={flag} active={fields.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>
                ))}
              </div>
            </div>

            <details open={!!fields.instructions}>
              <summary>Persistent instructions</summary>
              <Textarea rows={4} value={fields.instructions} placeholder="you are a code reviewer; read the diff and flag correctness issues…" onInput={(e) => set("instructions", (e.currentTarget as HTMLTextAreaElement).value)} />
              <div class="hint">Delivered as a startup prompt for claude / codex / agy / gemini.</div>
            </details>

            <div class="checks ash-check-grid">
              <label><input type="checkbox" checked={fields.autostart} onChange={(e) => set("autostart", (e.currentTarget as HTMLInputElement).checked)} /> Auto-start</label>
              <label><input type="checkbox" checked={fields.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.currentTarget as HTMLInputElement).checked)} /> Restart on crash</label>
              <label><input type="checkbox" checked={fields.attention} onChange={(e) => set("attention", (e.currentTarget as HTMLInputElement).checked)} /> Attention detection</label>
            </div>

            <div class="ash-group">
              <label class="ash-label" for="ash-cwd">Working directory</label>
              <div class="ash-row">
                <Input id="ash-cwd" value={fields.cwd} placeholder={`(workspace root: ${entity.defaultCwd})`} onInput={(e) => set("cwd", (e.currentTarget as HTMLInputElement).value)} />
                <Button onClick={() => dispatch.post(browseMessage())}>Browse</Button>
              </div>
            </div>

            {/* t-a1ba6c — advanced sections live in the main fields column (natural document flow
             * under Working directory). StudioFrame's sideActions slot sits AFTER flex:1 main and
             * was pinning these as a lonely bottom footer with a huge empty void on short forms. */}
            <details open={fields.worktree || !!fields.branch || !!fields.worktreeSetup || !!fields.verify}>
              <summary>Git worktree isolation</summary>
              <label class="check"><input type="checkbox" checked={fields.worktree} onChange={(e) => set("worktree", (e.currentTarget as HTMLInputElement).checked)} /> Run in its own git worktree + branch</label>
              <label class="ash-label" for="ash-branch">Branch (blank = tachyon/&lt;name&gt;)</label>
              <Input id="ash-branch" value={fields.branch} placeholder="feature/auth-redesign" onInput={(e) => set("branch", (e.currentTarget as HTMLInputElement).value)} />
              <label class="ash-label" for="ash-setup">Setup commands (run once on create)</label>
              <Textarea id="ash-setup" rows={3} value={fields.worktreeSetup} onInput={(e) => set("worktreeSetup", (e.currentTarget as HTMLTextAreaElement).value)} />
              <label class="ash-label" for="ash-verify">Verify gate (proves the branch is shippable)</label>
              <Input id="ash-verify" value={fields.verify} placeholder="npm test · cargo test · a command/runbook name" onInput={(e) => set("verify", (e.currentTarget as HTMLInputElement).value)} />
              <div class="ash-chips">
                {entity.verifyCandidates.map((c) => (
                  <Chip key={c} active={c === fields.verify.trim()} onClick={() => set("verify", c)}>{c}</Chip>
                ))}
              </div>
            </details>

            {showHarness && (
              <details open={fields.harness}>
                <summary>Isolated harness</summary>
                <label class="check"><input type="checkbox" checked={fields.harness} onChange={(e) => set("harness", (e.currentTarget as HTMLInputElement).checked)} /> {harnessCheckboxLabel}</label>
                <label class="ash-label" for="ash-inherit">Inherit</label>
                <Select id="ash-inherit" value={fields.harnessInherit} onChange={(e) => set("harnessInherit", (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="workspace">workspace</option>
                  <option value="none">none</option>
                </Select>
                <label class="ash-label" for="ash-mcp">MCP servers (YAML)</label>
                <Textarea id="ash-mcp" rows={6} value={fields.harnessMcp} onInput={(e) => set("harnessMcp", (e.currentTarget as HTMLTextAreaElement).value)} />
                {showHarnessInstructions && (
                  <>
                    <label class="ash-label" for="ash-instructions">Instruction files — one path per line</label>
                    <Textarea id="ash-instructions" rows={2} value={fields.harnessInstructions} onInput={(e) => set("harnessInstructions", (e.currentTarget as HTMLTextAreaElement).value)} />
                  </>
                )}
                {showHarnessRules && (
                  <>
                    <label class="ash-label" for="ash-rules">Rule files — one path per line</label>
                    <Textarea id="ash-rules" rows={2} value={fields.harnessRules} onInput={(e) => set("harnessRules", (e.currentTarget as HTMLTextAreaElement).value)} />
                  </>
                )}
                <label class="ash-label" for="ash-skills">Skill dirs — one path per line</label>
                <Textarea id="ash-skills" rows={2} value={fields.harnessSkills} onInput={(e) => set("harnessSkills", (e.currentTarget as HTMLTextAreaElement).value)} />
                <label class="ash-label" for="ash-hooks">Hooks (YAML)</label>
                <Textarea id="ash-hooks" rows={4} value={fields.harnessHooks} onInput={(e) => set("harnessHooks", (e.currentTarget as HTMLTextAreaElement).value)} />
              </details>
            )}
          </div>
        ),
      }}
    />
  );
}
