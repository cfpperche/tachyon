import { MarkdownView } from "../activity/markdown";
import { Button } from "../shared/ui";
import { useEffect, useState } from "preact/hooks";
import { stalenessLabel, noteGlyph, relativeTime, type HandoffViewModel, type HandoffNoteVM } from "./handoffViewModel";
import { buildHandoffDistillCommand, reconcileDistillSelection, type HandoffDistillMode } from "./distill";

// spec 245 inc D — the Project Handoff panel (Preact, render-only). A calm, curated DOCUMENT view (not a
// dashboard): a compact header + staleness badge, a metadata subline, the canonical handoff rendered as
// markdown, then the pending-note lane as a quiet secondary list. Read-only; never imports vscode.
// t-4eb7c0 — Distill re-requests a host snapshot on open so distillTargets match the fleet.
// t-1ba76d — "existing" lists declared agents (running/resumable/stopped), not only live panes.

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface HandoffDispatch {
  refresh(): void;
  openFile(): void;
  distillExisting(agent: string, instructions?: string): void;
  distillAdhoc(profileId: string, args?: string, instructions?: string): void;
}

/** One pending note row: kind glyph + agent + relative age + summary, with dimmed evidence beneath. */
function NoteRow({ n, now }: { n: HandoffNoteVM; now: Date }) {
  const age = relativeTime(n.ts, now);
  return (
    <div class="note">
      <div class="note-top">
        <span class="nglyph" aria-hidden="true">{noteGlyph(n.kind)}</span>
        <span class="nagent">{n.agent}</span>
        {age && <span class="nage">· {age}</span>}
        <span class="nsum">{n.summary}</span>
      </div>
      {n.evidence.length > 0 && (
        <div class="nevidence">{n.evidence.join(" · ")}</div>
      )}
    </div>
  );
}

function DistillBox({ vm, dispatch, onClose }: { vm: HandoffViewModel; dispatch: HandoffDispatch; onClose(): void }) {
  const [mode, setMode] = useState<HandoffDistillMode>(vm.distillTargets.length > 0 ? "existing" : "adhoc");
  const [agent, setAgent] = useState(vm.distillTargets[0]?.name ?? "");
  const [profileId, setProfileId] = useState<string>(vm.distillProfiles[0]?.id ?? "codex:default");
  const [args, setArgs] = useState("");
  const [instructions, setInstructions] = useState("");
  const canUseExisting = vm.distillTargets.length > 0;
  const profile = vm.distillProfiles.find((p) => p.id === profileId) ?? vm.distillProfiles[0];
  const commandPreview = profile ? buildHandoffDistillCommand(profile, args) : "";
  const canStart = mode === "existing" ? !!agent : !!profile;

  // t-4eb7c0 — host only recomputes distillTargets on snapshot post; open always re-pulls live agents.
  // Mount-only: Root builds a fresh dispatch object every render, so [dispatch] would refresh-loop.
  useEffect(() => {
    dispatch.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per Distill open
  }, []);

  // Async refresh can repost targets after mount — keep selection coherent without wiping owner edits.
  useEffect(() => {
    const next = reconcileDistillSelection(vm.distillTargets, { mode, agent });
    if (next.mode !== mode) setMode(next.mode);
    if (next.agent !== agent) setAgent(next.agent);
  }, [vm.distillTargets, mode, agent]);

  const submit = () => {
    if (!canStart) return;
    if (mode === "existing") dispatch.distillExisting(agent, instructions);
    else if (profile) dispatch.distillAdhoc(profile.id, args, instructions);
    onClose();
  };

  return (
    <div class="distill-box" role="region" aria-label="Distill project handoff">
      <div class="distill-row">
        <label>
          Target
          <select value={mode} onChange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as HandoffDistillMode)}>
            <option value="existing" disabled={!canUseExisting}>Declared / running agent</option>
            <option value="adhoc">Ad-hoc agent</option>
          </select>
        </label>
        {mode === "existing" ? (
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent((e.currentTarget as HTMLSelectElement).value)}>
              {vm.distillTargets.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.description}</option>)}
            </select>
          </label>
        ) : (
          <label>
            Runtime
            <select value={profile?.id ?? ""} onChange={(e) => setProfileId((e.currentTarget as HTMLSelectElement).value)}>
              {vm.distillProfiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}
      </div>
      {mode === "adhoc" && profile && (
        <>
          <label class="distill-args">
            Runtime arguments
            <input value={args} placeholder="Optional, e.g. --model sonnet" onInput={(e) => setArgs((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <div class="command-preview" aria-label="Ad-hoc command preview">
            <div>
              <span class="preview-label">Command preview</span>
              <code>{commandPreview}</code>
            </div>
            <span class="ds-dim">{profile.note}</span>
          </div>
        </>
      )}
      <label class="distill-instructions">
        Additional instruction
        <textarea value={instructions} rows={3} placeholder="Optional constraints for the handoff distillation" onInput={(e) => setInstructions((e.currentTarget as HTMLTextAreaElement).value)} />
      </label>
      <div class="distill-actions">
        <span class="ds-dim">The agent drafts first; applying the rewrite still requires human approval.</span>
        <Button title="Cancel" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="wand" title="Start handoff distillation" disabled={!canStart} onClick={submit}>Start</Button>
      </div>
    </div>
  );
}

export function App({ vm, dispatch }: { vm?: HandoffViewModel; dispatch: HandoffDispatch }) {
  // The host stamps the VM; for a read-only doc, "now" at render is fine for the relative ages.
  const now = new Date();
  const [distillOpen, setDistillOpen] = useState(false);
  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading the project handoff…</div></div>;
  }

  const badge = stalenessLabel(vm.staleness);
  const open = (
    <Button icon="go-to-file" title="Open the handoff file" onClick={() => dispatch.openFile()}>
      Open
    </Button>
  );

  const toggleDistill = () => {
    setDistillOpen((openNow) => {
      // Also request refresh at the toggle edge so the host starts list() before DistillBox mounts.
      if (!openNow) dispatch.refresh();
      return !openNow;
    });
  };

  return (
    <div>
      <div class="head">
        <h1 class="ds-title"><span aria-hidden="true">◆</span> Project Handoff — {vm.folder}</h1>
        <span class={`ds-badge ${badge.tone}`} title={`Staleness: ${badge.label}`}>
          <span aria-hidden="true">{badge.glyph}</span> {badge.label}
          {vm.staleness === "needs_distill" && vm.pendingCount > 0 ? ` · ${vm.pendingCount}` : ""}
        </span>
        <span class="actions">
          <Button icon="wand" title="Distill pending notes with an agent" onClick={toggleDistill}>
            Distill
          </Button>
          {open}
          <Button icon="refresh" title="Refresh" onClick={() => dispatch.refresh()}>
            Refresh
          </Button>
        </span>
      </div>
      {distillOpen && <DistillBox vm={vm} dispatch={dispatch} onClose={() => setDistillOpen(false)} />}

      {vm.exists ? (
        <div class="body">
          <div class="meta">
            {vm.updatedAt && <span>updated {relativeTime(vm.updatedAt, now) || vm.updatedAt}</span>}
            {vm.updatedBy && <span>· by {vm.updatedBy}</span>}
            {vm.revision && <span>· revision {vm.revision.slice(0, 8)}</span>}
          </div>
          {/* Reuse the Activity panel's SANITIZED markdown component (DOMPurify + mermaid + math) — never raw
              renderMarkdownHtml: the handoff body is agent/human-authored, so it must go through the same sanitizer
              the assistant feed uses (codex P1 — defense-in-depth beyond the CSP). */}
          <MarkdownView text={vm.body} />
        </div>
      ) : (
        <div class="cold">
          <span class="codicon codicon-book" />
          <div>No project handoff yet.</div>
          <div class="ds-dim">Open it to create the file from the 4-section template, then curate the state of the work.</div>
          {open}
        </div>
      )}

      <div class="notes">
        <h2><Icon name="list-unordered" /> Pending notes · {vm.notes.length}</h2>
        {vm.notes.length === 0
          ? <div class="ds-dim empty">no pending notes</div>
          : vm.notes.map((n, i) => <NoteRow key={i} n={n} now={now} />)}
      </div>
    </div>
  );
}
