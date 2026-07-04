import { useEffect, useState } from "preact/hooks";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { Chip, Select } from "../shared/ui";
import { cancelMessage, readyMessage, saveMessage } from "./messages";
import type { AgentFixtureFields, AgentFixtureHostMessage, AgentFixtureVM } from "./types";

/**
 * spec 350 T5 — Fake 2: the Agent tab's densest real fields (quick-add chips, role select, instructions,
 * worktree section) rendered as domain components inside the shell's declared regions. No dirty/validation/
 * persistence proof here (Fake 1 owns that) — this is a REGION-composition proof only.
 */

export interface AgentFixtureDispatch {
  post(msg: unknown): void;
}

export function App({ dispatch }: { dispatch: AgentFixtureDispatch }) {
  const [vm, setVm] = useState<AgentFixtureVM | undefined>(undefined);
  const [fields, setFields] = useState<AgentFixtureFields | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as AgentFixtureHostMessage | undefined;
      if (!d || d.type !== "load") return;
      setVm(d.entity);
      setFields(d.entity.fields);
    };
    window.addEventListener("message", onMsg);
    dispatch.post(readyMessage());
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!vm || !fields) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Agent fixture...</div></div>;
  }

  const setField = <K extends keyof AgentFixtureFields>(key: K, value: AgentFixtureFields[K]) => setFields((f) => (f ? { ...f, [key]: value } : f));
  const setWorktree = <K extends keyof AgentFixtureFields["worktree"]>(key: K, value: AgentFixtureFields["worktree"][K]) =>
    setFields((f) => (f ? { ...f, worktree: { ...f.worktree, [key]: value } } : f));

  return (
    <StudioFrame
      title={vm.mode === "new" ? "New Agent" : `Edit Agent — ${vm.entityId ?? ""}`}
      errors={[]}
      dirty={false}
      saveInFlight={false}
      canSave={fields.name.trim().length > 0}
      onSave={() => dispatch.post(saveMessage())}
      onCancel={() => dispatch.post(cancelMessage())}
      regions={{
        fields: (
          <div class="asf-fields">
            <label class="asf-label" for="asf-name">Name</label>
            <input id="asf-name" class="ds-input" value={fields.name} onInput={(e) => setField("name", (e.currentTarget as HTMLInputElement).value)} />

            <label class="asf-label" for="asf-command">Command</label>
            <input id="asf-command" class="ds-input" value={fields.command} onInput={(e) => setField("command", (e.currentTarget as HTMLInputElement).value)} />

            <div class="asf-label">Quick add (detected on this machine)</div>
            <div class="asf-chips" role="group" aria-label="Quick add">
              {vm.chips.map((c) => (
                <Chip
                  key={c.cli}
                  active={fields.command === c.cli}
                  disabled={!c.installed}
                  icon={c.installed ? "check" : "circle-slash"}
                  onClick={() => c.installed && setField("command", c.cli)}
                >
                  {c.cli}
                </Chip>
              ))}
            </div>

            <label class="asf-label" for="asf-role">Role template</label>
            <Select id="asf-role" value={fields.role ?? ""} onChange={(e) => setField("role", (e.currentTarget as HTMLSelectElement).value || null)}>
              <option value="">(none)</option>
              {vm.roleOptions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>

            <label class="asf-label" for="asf-instructions">Instructions (role prompt)</label>
            <textarea id="asf-instructions" class="ds-input asf-instructions" value={fields.instructions} onInput={(e) => setField("instructions", (e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
        ),
        sideActions: (
          <div class="asf-worktree">
            <label class="asf-worktree-toggle">
              <input type="checkbox" checked={fields.worktree.enabled} onChange={(e) => setWorktree("enabled", (e.currentTarget as HTMLInputElement).checked)} />
              Run in its own git worktree + branch
            </label>
            {fields.worktree.enabled && (
              <>
                <label class="asf-label" for="asf-branch">Branch (blank = tachyon/&lt;name&gt;)</label>
                <input id="asf-branch" class="ds-input" value={fields.worktree.branch} onInput={(e) => setWorktree("branch", (e.currentTarget as HTMLInputElement).value)} />
                <label class="asf-label" for="asf-setup">Setup commands (run once on create)</label>
                <textarea id="asf-setup" class="ds-input asf-instructions" value={fields.worktree.setupCommands} onInput={(e) => setWorktree("setupCommands", (e.currentTarget as HTMLTextAreaElement).value)} />
              </>
            )}
          </div>
        ),
      }}
    />
  );
}
