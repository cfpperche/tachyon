import { useEffect, useRef, useState } from "preact/hooks";
import { decodeStudioMessage } from "../shared/studio/protocol";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { Button, Chip, Input, Select, Textarea } from "../shared/ui";
import { agentStudioTitleFor, blankAgentFields, computeAgentDirty } from "./domain";
import { browseMessage, cancelMessage, dirtyMessage, patchMessage, readyMessage, saveMessage } from "./messages";
import type { AgentStudioEntity, AgentStudioFields, AgentStudioHostMessage } from "./types";

/**
 * spec 350 Phase 3 T3 — the Agent-kind studio's webview surface: the legacy Agent Studio's Agent-tab field
 * set (quick-add chips, name, command + flag chips, role template, instructions, autostart/restart/attention,
 * worktree section, isolated-harness section) rendered inside StudioFrame's declared regions instead of the
 * legacy AgentForm's hand-rolled chrome. Faithful port of the FIELDS — same field names, same show/hide rules
 * (isolate/harness only for a claude/codex command) — just no kind tabs (this studio only ever creates/edits
 * `kind: "agent"`; Terminal/Command/Runbook/Schedule stay on the legacy `agent-studio/App.tsx` + AgentForm.ts
 * during coexistence, untouched by this file).
 *
 * `firstToken`/`harnessRuntimeOfCmd` are deliberately reimplemented here (not imported from formLogic.ts) —
 * the SAME choice the legacy `agent-studio/App.tsx` already makes for its own copies: formLogic.ts's runtime
 * exports transitively pull in `node:fs` (via config/loadConfig.ts), which this browser bundle can't resolve
 * (see agent-studio-shell/domain.ts's header for the empirical confirmation).
 */

export interface AgentStudioDispatch {
  post(msg: unknown): void;
}

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const harnessRuntimeOfCmd = (cmd: string): "claude" | "codex" | undefined => {
  const bin = firstToken(cmd);
  return bin === "claude" || bin === "codex" ? bin : undefined;
};

export function App({ dispatch }: { dispatch: AgentStudioDispatch }) {
  const [mode, setMode] = useState<"new" | "edit">("new");
  const [entityId, setEntityId] = useState<string | undefined>(undefined);
  const [entity, setEntity] = useState<AgentStudioEntity | undefined>(undefined);
  const [fields, setFields] = useState<AgentStudioFields>(blankAgentFields());
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [ready, setReady] = useState(false);
  const entityRef = useRef<AgentStudioEntity | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const decoded = decodeStudioMessage<AgentStudioHostMessage>(e.data, ["cwd"]);
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
        setFields(d.entity.fields);
        setMode(d.entity.name === undefined ? "new" : "edit");
        setEntityId(d.entity.name);
        setSaveInFlight(!!d.saveInFlight);
        setHostError(undefined);
        setLoadFailed(false);
        setReady(true);
      } else if (d.type === "error") {
        setHostError({ code: d.code, message: d.message, source: "persistence", blocking: d.blocking });
        if (!entity) setLoadFailed(true);
        setSaveInFlight(false);
        setReady(true);
      } else if (d.type === "restore") {
        if (d.snapshot?.patch) setFields(d.snapshot.patch);
      } else if (d.type === "cwd") {
        setFields((f) => ({ ...f, cwd: d.value }));
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

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Agent Studio...</div></div>;
  }

  const errors: StudioError[] = hostError ? [hostError] : [];
  const canSave = computeCanSave({ dirty, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });
  const set = <K extends keyof AgentStudioFields>(key: K, value: AgentStudioFields[K]) => setFields((f) => ({ ...f, [key]: value }));
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
    setFields((f) => ({ ...f, cmd: bin, name }));
  };

  const flags = entity.flagMap[firstToken(fields.cmd)] ?? [];
  const harnessRuntime = harnessRuntimeOfCmd(fields.cmd);
  const showHarness = !!harnessRuntime;
  const codexHarness = harnessRuntime === "codex";

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
                  <Chip key={c.bin} active={fields.cmd === c.bin} disabled={!c.detected} icon={c.detected ? "check" : "circle-slash"} onClick={() => c.detected && pickChip(c.bin)} title={c.installHint}>
                    {c.label}
                  </Chip>
                ))}
              </div>
            </div>

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
              <summary>Instructions (role prompt)</summary>
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
          </div>
        ),
        sideActions: (
          <div class="ash-side">
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
              <div class="ash-isolate">
                <label class="check"><input type="checkbox" checked={fields.isolate} disabled={fields.harness} onChange={(e) => set("isolate", (e.currentTarget as HTMLInputElement).checked)} /> Isolate transcript (own session namespace, same folder)</label>
              </div>
            )}

            {showHarness && (
              <details open={fields.harness}>
                <summary>Isolated harness</summary>
                <label class="check"><input type="checkbox" checked={fields.harness} onChange={(e) => set("harness", (e.currentTarget as HTMLInputElement).checked)} /> {codexHarness ? "Give this Codex agent its own config, skills, hooks, and MCP" : "Give this agent its own MCP / skills / rules / hooks"}</label>
                <label class="ash-label" for="ash-inherit">Inherit</label>
                <Select id="ash-inherit" value={fields.harnessInherit} onChange={(e) => set("harnessInherit", (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="workspace">workspace</option>
                  <option value="none">none</option>
                </Select>
                <label class="ash-label" for="ash-mcp">MCP servers (YAML)</label>
                <Textarea id="ash-mcp" rows={6} value={fields.harnessMcp} onInput={(e) => set("harnessMcp", (e.currentTarget as HTMLTextAreaElement).value)} />
                {codexHarness ? (
                  <>
                    <label class="ash-label" for="ash-instructions">Instruction files — one path per line</label>
                    <Textarea id="ash-instructions" rows={2} value={fields.harnessInstructions} onInput={(e) => set("harnessInstructions", (e.currentTarget as HTMLTextAreaElement).value)} />
                  </>
                ) : (
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
