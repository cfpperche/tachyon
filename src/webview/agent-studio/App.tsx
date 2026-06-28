import { useEffect, useRef, useState } from "preact/hooks";
import type { FormState, StudioKind } from "../formLogic";
import { Tabs, Chip, Button, type TabItem } from "../shared/ui";
import {
  INIT, KIND_INFERRED, CWD, ERRORS, tabAction, inferKindAction, browseAction, submitAction, cancelAction,
  type StudioHostMessage, type StudioAction, type InitPayload,
} from "./messages";

// spec 279 — the Agent Studio form (converted from AgentForm's ~500-line inline <script>). The KIND is a row
// of tabs; each shows its own fields. All validation/entry-building stays in formLogic.ts (unit-tested); this
// renders state + relays messages. Faithful port — same fields, same host actions, same gating.

const BLANK: FormState = {
  name: "", cmd: "", kind: "agent", instructions: "", role: "", watch: "", steps: "", cwd: "",
  autostart: false, restartOnCrash: false, attention: true,
  worktree: false, branch: "", worktreeSetup: "", verify: "",
  harness: false, harnessInherit: "workspace", harnessMcp: "", harnessRules: "", harnessSkills: "", harnessHooks: "",
  isolate: false,
  schedTiming: "every", schedEvery: "", schedAt: "", schedAction: "run", schedTarget: "", catchUp: false,
};

const firstToken = (cmd: string): string => (cmd.trim().split(/\s+/)[0] || "").split("/").pop() || "";
const hasClaude = (cmd: string): boolean => cmd.trim().split(/\s+/).some((t) => t.split("/").pop() === "claude");

export function Studio({ post, postReady }: { post: (a: StudioAction) => void; postReady: () => void }) {
  const [cfg, setCfg] = useState<InitPayload | undefined>(undefined);
  const [form, setForm] = useState<FormState>(BLANK);
  const [inferred, setInferred] = useState<StudioKind>("agent");
  const [attentionTouched, setAttentionTouched] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const cmdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data as StudioHostMessage | undefined;
      if (!m) return;
      if (m.type === INIT) {
        setCfg(m);
        if (m.initial) {
          setForm({ ...m.initial });
          setInferred(m.initial.kind);
          setAttentionTouched(true);
        } else {
          const k = m.initialKind ?? "agent";
          setForm({ ...BLANK, kind: k, attention: k === "agent" });
          setInferred(k);
        }
      } else if (m.type === KIND_INFERRED) setInferred(m.kind);
      else if (m.type === CWD) setForm((f) => ({ ...f, cwd: m.value }));
      else if (m.type === ERRORS) setErrors(m.errors);
    };
    window.addEventListener("message", onMsg);
    postReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (!cfg) return <div class="ds-empty" />;
  const s = cfg.strings;
  const k = form.kind;
  const editing = cfg.editingName;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const pickTab = (nk: StudioKind) => {
    if (editing) return; // kind is fixed once an entry exists (spec 215)
    setForm((f) => ({ ...f, kind: nk, ...(attentionTouched ? {} : { attention: nk === "agent" }) }));
    post(tabAction(nk));
  };
  const onCmd = (v: string) => { set("cmd", v); post(inferKindAction(v)); };
  const toggleFlag = (flag: string) => {
    const cmd = form.cmd;
    const has = cmd.includes(" " + flag) || cmd.trim().endsWith(flag);
    set("cmd", has ? cmd.replace(" " + flag, "").trim() : cmd.trim() + " " + flag);
  };
  const pickChip = (bin: string) => {
    let name = form.name;
    if (!form.name || !editing) {
      let n = bin, i = 2;
      while (cfg.taken.includes(n) && n !== editing) n = bin + "-" + i++;
      name = n;
    }
    setForm((f) => ({ ...f, cmd: bin, name }));
    setInferred("agent");
  };
  const submit = () => post(submitAction({
    ...form,
    name: form.name.trim(), cmd: form.cmd.trim(), cwd: form.cwd.trim(), branch: form.branch.trim(), verify: form.verify.trim(), schedTarget: form.schedTarget.trim(),
    schedEvery: form.schedTiming === "every" ? form.schedEvery.trim() : (form.schedEvery || "1h"),
    schedAt: form.schedTiming === "at" ? form.schedAt.trim() : (form.schedAt || "09:00"),
  }));

  // per-kind visibility (mirrors the old setTab show/hide)
  const isAgent = k === "agent", isTerminal = k === "terminal", isRunbook = k === "runbook", isSched = k === "schedule";
  const showCmd = !(isRunbook || isSched), showCwd = !(isRunbook || isSched);
  const showInstr = isAgent || (isSched && form.schedAction === "spawn");
  const showHarness = isAgent && hasClaude(form.cmd);
  const switchMismatch = !editing && (isAgent || isTerminal) && form.cmd.trim().length > 0 && inferred !== k;
  const flags = cfg.flagMap[firstToken(form.cmd)] ?? [];
  const titleNew = { agent: s.titleNewAgent, terminal: s.titleNewTerminal, command: s.titleNewCommand, runbook: s.titleNewRunbook, schedule: s.titleNewSchedule }[k];
  const titleEdit = { agent: s.titleEditAgent, terminal: s.titleEditTerminal, command: s.titleEditCommand, runbook: s.titleEditRunbook, schedule: s.titleEditSchedule }[k];
  const stepsLines = form.steps.split("\n").map((l) => l.trim()).filter(Boolean);

  const tabItems: TabItem[] = [
    { id: "agent", icon: "hubot", label: s.tabAgent },
    { id: "terminal", icon: "terminal", label: s.tabTerminal },
    { id: "command", icon: "play", label: s.tabCommand },
    { id: "runbook", icon: "checklist", label: s.tabRunbook },
    { id: "schedule", icon: "clock", label: s.tabSchedule },
  ];

  return (
    <>
      <Tabs items={tabItems} active={k} locked={!!editing} onSelect={(id) => pickTab(id as StudioKind)} />
      <div class="tabHint">{{ agent: s.tabHintAgent, terminal: s.tabHintTerminal, command: s.tabHintCommand, runbook: s.tabHintRunbook, schedule: s.tabHintSchedule }[k]}</div>

      <h2 class="ds-title"><span class="codicon codicon-zap" />{editing ? titleEdit.replace("{0}", editing) : titleNew}</h2>

      {isAgent && (
        <div id="quickAddBlock">
          <label class="ds-section">{s.quickAdd}</label>
          <div class="chips" id="cliChips">
            {cfg.chips.map((c) => c.detected ? (
              <Chip icon="check" title={c.bin} onClick={() => pickChip(c.bin)}>{c.label}</Chip>
            ) : (
              <Chip disabled icon="circle-slash" title={c.installHint ? s.notInstalled.replace("{0}", c.installHint) : s.notInstalledNoHint}>{c.label}</Chip>
            ))}
            <Chip icon="edit" onClick={() => { setForm((f) => ({ ...f, cmd: "", name: "" })); cmdRef.current?.focus(); }}>{s.custom}</Chip>
          </div>
        </div>
      )}

      <label class="ds-section">{s.name}</label>
      <input type="text" value={form.name} placeholder={{ agent: s.namePhAgent, terminal: s.namePhTerminal, command: s.namePhCommand, runbook: s.namePhRunbook, schedule: s.namePhSchedule }[k]} onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
      <div class="hint">{s.nameHint}</div>

      {showCmd && (
        <div id="cmdBlock">
          <label class="ds-section">{s.command}</label>
          <input ref={cmdRef} type="text" value={form.cmd} placeholder={isAgent ? s.commandPhAgent : isTerminal ? s.commandPhTerminal : s.commandPhCommand} onInput={(e) => onCmd((e.target as HTMLInputElement).value)} />
          {switchMismatch && <span class="switchHint visible" onClick={() => pickTab(inferred)}>{inferred === "agent" ? s.switchToAgent : s.switchToTerminal}</span>}
          <div class="chips">{flags.map((flag) => <Chip active={form.cmd.includes(flag)} onClick={() => toggleFlag(flag)}>{flag}</Chip>)}</div>
        </div>
      )}

      {isRunbook && (
        <div id="stepsBlock">
          <label class="ds-section">{s.stepsLabel}</label>
          <textarea rows={5} value={form.steps} placeholder={s.stepsPh} onInput={(e) => set("steps", (e.target as HTMLTextAreaElement).value)} />
          <div class="hint">{s.stepsHint}</div>
          <div class="hint">{stepsLines.map((l) => `${l} → ${cfg.commandNames.includes(l) ? s.stepRef : s.stepInline}`).join(" · ")}</div>
        </div>
      )}

      {isSched && (
        <div id="schedBlock">
          <label class="ds-section">{s.schedWhen}</label>
          <div class="chips">
            <Chip active={form.schedTiming === "every"} onClick={() => set("schedTiming", "every")}>{s.schedEvery}</Chip>
            <Chip active={form.schedTiming === "at"} onClick={() => set("schedTiming", "at")}>{s.schedAt}</Chip>
          </div>
          <input type="text" placeholder={form.schedTiming === "every" ? s.schedEveryPh : s.schedAtPh}
            value={form.schedTiming === "every" ? form.schedEvery : form.schedAt}
            onInput={(e) => set(form.schedTiming === "every" ? "schedEvery" : "schedAt", (e.target as HTMLInputElement).value)} />
          <label class="ds-section">{s.schedAction}</label>
          <div class="chips">
            <Chip active={form.schedAction === "run"} onClick={() => set("schedAction", "run")}>{s.schedRun}</Chip>
            <Chip active={form.schedAction === "spawn"} onClick={() => set("schedAction", "spawn")}>{s.schedSpawn}</Chip>
          </div>
          <input type="text" value={form.schedTarget} placeholder={s.schedTargetPh} onInput={(e) => set("schedTarget", (e.target as HTMLInputElement).value)} />
          <div class="hint">{s.schedTargetPh}</div>
          {form.schedTiming === "at" && (
            <div class="checks"><label><input type="checkbox" checked={form.catchUp} onChange={(e) => set("catchUp", (e.target as HTMLInputElement).checked)} /> {s.schedCatchUp}</label></div>
          )}
        </div>
      )}

      {isAgent && (
        <div id="roleBlock">
          <label class="ds-section">{s.role}</label>
          <select value={form.role} onChange={(e) => set("role", (e.target as HTMLSelectElement).value)}>
            <option value="">{s.roleNone}</option>
            <option value="coder">coder</option><option value="reviewer">reviewer</option>
            <option value="tester">tester</option><option value="orchestrator">orchestrator</option><option value="custom">custom</option>
          </select>
          <div class="hint">{s.roleHint}</div>
        </div>
      )}

      {showInstr && (
        <details open={!!form.instructions}>
          <summary>{s.instructions}</summary>
          <textarea rows={4} value={form.instructions} placeholder={s.instructionsPh} onInput={(e) => set("instructions", (e.target as HTMLTextAreaElement).value)} />
          <div class="hint">{s.instructionsHint}</div>
        </details>
      )}

      {isTerminal && (
        <div id="watchBlock">
          <label class="ds-section">{s.watch}</label>
          <input type="text" value={form.watch} placeholder={s.watchPh} onInput={(e) => set("watch", (e.target as HTMLInputElement).value)} />
          <div class="hint">{s.watchHint}</div>
        </div>
      )}

      {showCwd && (
        <div id="cwdBlock">
          <label class="ds-section">{s.cwd}</label>
          <div class="row">
            <input type="text" value={form.cwd} placeholder={s.cwdRootPh.replace("{0}", cfg.defaultCwd)} onInput={(e) => set("cwd", (e.target as HTMLInputElement).value)} />
            <Button onClick={() => post(browseAction())}>{s.browse}</Button>
          </div>
        </div>
      )}

      {(isAgent || isTerminal) && (
        <div class="checks">
          <label><input type="checkbox" checked={form.autostart} onChange={(e) => set("autostart", (e.target as HTMLInputElement).checked)} /> {s.autostart}</label>
          <label><input type="checkbox" checked={form.restartOnCrash} onChange={(e) => set("restartOnCrash", (e.target as HTMLInputElement).checked)} /> {s.restart}</label>
          <label><input type="checkbox" checked={form.attention} onChange={(e) => { setAttentionTouched(true); set("attention", (e.target as HTMLInputElement).checked); }} /> {s.attention}</label>
        </div>
      )}

      {(isAgent || isTerminal) && (
        <details open={form.worktree || !!form.branch || !!form.worktreeSetup || !!form.verify}>
          <summary>{s.worktreeSummary}</summary>
          <label class="check"><input type="checkbox" checked={form.worktree} onChange={(e) => set("worktree", (e.target as HTMLInputElement).checked)} /> {s.worktree}</label>
          <label class="ds-section">{s.branch}</label>
          <input type="text" value={form.branch} placeholder={s.branchPh} onInput={(e) => set("branch", (e.target as HTMLInputElement).value)} />
          <label class="ds-section">{s.worktreeSetup}</label>
          <textarea rows={3} value={form.worktreeSetup} placeholder={s.worktreeSetupPh} onInput={(e) => set("worktreeSetup", (e.target as HTMLTextAreaElement).value)} />
          <div class="hint">{s.worktreeHint}</div>
          <label class="ds-section">{s.verify}</label>
          <input type="text" value={form.verify} placeholder={s.verifyPh} onInput={(e) => set("verify", (e.target as HTMLInputElement).value)} />
          <div class="chips" title={s.verifySuggested}>{cfg.verifyCandidates.map((c) => <Chip active={c === form.verify.trim()} onClick={() => set("verify", c)}>{c}</Chip>)}</div>
          <div class="hint">{s.verifyHint}</div>
        </details>
      )}

      {showHarness && (
        <div id="isolateBlock">
          <label class="check"><input type="checkbox" checked={form.isolate} disabled={form.harness} onChange={(e) => set("isolate", (e.target as HTMLInputElement).checked)} /> {s.isolate}</label>
          <div class="hint">{s.isolateHint}</div>
        </div>
      )}

      {showHarness && (
        <details open={form.harness}>
          <summary>{s.harnessSummary}</summary>
          <label class="check"><input type="checkbox" checked={form.harness} onChange={(e) => set("harness", (e.target as HTMLInputElement).checked)} /> {s.harness}</label>
          <div class="hint">{s.harnessHint}</div>
          <label class="ds-section">{s.harnessInherit}</label>
          <select value={form.harnessInherit} onChange={(e) => set("harnessInherit", (e.target as HTMLSelectElement).value)}><option value="workspace">workspace</option><option value="none">none</option></select>
          <label class="ds-section">{s.harnessMcpLabel}</label>
          <textarea rows={6} value={form.harnessMcp} placeholder={s.harnessMcpPh} onInput={(e) => set("harnessMcp", (e.target as HTMLTextAreaElement).value)} />
          <label class="ds-section">{s.harnessRulesLabel}</label>
          <textarea rows={2} value={form.harnessRules} placeholder={s.harnessRulesPh} onInput={(e) => set("harnessRules", (e.target as HTMLTextAreaElement).value)} />
          <label class="ds-section">{s.harnessSkillsLabel}</label>
          <textarea rows={2} value={form.harnessSkills} placeholder={s.harnessSkillsPh} onInput={(e) => set("harnessSkills", (e.target as HTMLTextAreaElement).value)} />
          <label class="ds-section">{s.harnessHooksLabel}</label>
          <textarea rows={4} value={form.harnessHooks} placeholder={s.harnessHooksPh} onInput={(e) => set("harnessHooks", (e.target as HTMLTextAreaElement).value)} />
        </details>
      )}

      {errors.length > 0 && <div class="errors visible">{errors.join("\n")}</div>}

      <div class="actions">
        <Button onClick={() => post(cancelAction())}>{s.cancel}</Button>
        <Button variant="primary" onClick={submit}>{{ agent: s.saveAgent, terminal: s.saveTerminal, command: s.saveCommand, runbook: s.saveRunbook, schedule: s.saveSchedule }[k]}</Button>
      </div>
    </>
  );
}
