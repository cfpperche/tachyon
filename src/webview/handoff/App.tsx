import { MarkdownView } from "../activity/markdown";
import { stalenessLabel, noteGlyph, relativeTime, type HandoffViewModel, type HandoffNoteVM } from "./handoffViewModel";

// spec 245 inc D — the Project Handoff panel (Preact, render-only). A calm, curated DOCUMENT view (not a
// dashboard): a compact header + staleness badge, a metadata subline, the canonical handoff rendered as
// markdown, then the pending-note lane as a quiet secondary list. Read-only; never imports vscode.

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface HandoffDispatch {
  refresh(): void;
  openFile(): void;
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

export function App({ vm, dispatch }: { vm?: HandoffViewModel; dispatch: HandoffDispatch }) {
  // The host stamps the VM; for a read-only doc, "now" at render is fine for the relative ages.
  const now = new Date();
  if (!vm) {
    return <div class="degrade"><span class="codicon codicon-loading" /><div>Loading the project handoff…</div></div>;
  }

  const badge = stalenessLabel(vm.staleness);
  const open = (
    <button class="act-btn" title="Open the handoff file" onClick={() => dispatch.openFile()}>
      <Icon name="go-to-file" /> Open
    </button>
  );

  return (
    <div>
      <div class="head">
        <h1><span aria-hidden="true">◆</span> Project Handoff — {vm.folder}</h1>
        <span class={`badge ${badge.tone}`} title={`Staleness: ${badge.label}`}>
          <span aria-hidden="true">{badge.glyph}</span> {badge.label}
          {vm.staleness === "needs_distill" && vm.pendingCount > 0 ? ` · ${vm.pendingCount}` : ""}
        </span>
        <span class="actions">
          {open}
          <button class="act-btn" title="Refresh" onClick={() => dispatch.refresh()}>
            <Icon name="refresh" /> Refresh
          </button>
        </span>
      </div>

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
          <div class="dim">Open it to create the file from the 4-section template, then curate the state of the work.</div>
          {open}
        </div>
      )}

      <div class="notes">
        <h2><Icon name="list-unordered" /> Pending notes · {vm.notes.length}</h2>
        {vm.notes.length === 0
          ? <div class="dim empty">no pending notes</div>
          : vm.notes.map((n, i) => <NoteRow key={i} n={n} now={now} />)}
      </div>
    </div>
  );
}
