import { useMemo, useState } from "preact/hooks";
import type { ChangedFile } from "@tachyon/engine/worktree/review.js";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import { Badge, Button, EmptyState, PageChrome, Select, Textarea } from "../shared/ui";
import { noteMigrated, notesOnLine, orphanedNotes, visibleNewLinesFrom } from "./notes";
import { renderReviewDiff, type ReviewRenderLine } from "./render";
import type { ReviewVM } from "./messages";

export interface ReviewDispatch {
  selectFile(path: string): void;
  upsertNote(path: string, line: number, body: string): void;
  sendBatch(agent: string): void;
}

function statusLabel(status: ChangedFile["status"]): string {
  return status;
}

function noteTone(note: ReviewNote): "warn" | "info" | "ok" {
  if (note.status === "outdated") return "warn";
  if (noteMigrated(note)) return "info";
  return "ok";
}

function noteKindLabel(note: ReviewNote): string {
  if (note.status === "outdated") return "outdated";
  if (noteMigrated(note)) return "migrated";
  return "active";
}

function NoteCard({ note }: { note: ReviewNote }) {
  return (
    <article
      class="review-note"
      data-testid={`review-note-${note.identity.commentId}`}
      data-status={note.status}
      data-reconcile={note.lastReconcile?.kind ?? ""}
    >
      <header class="review-note-head">
        <Badge tone={noteTone(note)}>{noteKindLabel(note)}</Badge>
        <span class="review-note-loc">{note.lastPath}:{note.lastLine}</span>
      </header>
      <p class="review-note-body">{note.body}</p>
    </article>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: ChangedFile;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      type="button"
      class={`review-file${selected ? " is-selected" : ""}`}
      data-testid={`review-file-${file.path}`}
      data-status={file.status}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(file.path)}
    >
      <span class={`review-file-status st-${file.status}`}>{statusLabel(file.status)}</span>
      <span class="review-file-path">{file.from && file.from !== file.path ? `${file.from} → ${file.path}` : file.path}</span>
    </button>
  );
}

function Ruler({
  line,
  onAnnotate,
}: {
  line: ReviewRenderLine;
  onAnnotate: (newLine: number) => void;
}) {
  if (!line.annotatable || line.newLine === null) {
    return <span class="review-ruler is-inert" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      class="review-ruler"
      data-testid={`review-ruler-${line.newLine}`}
      title={`Comment on line ${line.newLine}`}
      aria-label={`Comment on line ${line.newLine}`}
      onClick={() => onAnnotate(line.newLine!)}
    >
      +
    </button>
  );
}

function Composer({
  line,
  onSubmit,
  onCancel,
}: {
  line: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const save = (): void => {
    const next = body.trim();
    if (!next) return;
    onSubmit(next);
  };
  return (
    <div class="review-composer" data-testid={`review-composer-${line}`}>
      <Textarea
        class="review-composer-input"
        rows={3}
        value={body}
        placeholder="Note on this line (modified side)"
        onInput={(event) => setBody((event.currentTarget as HTMLTextAreaElement).value)}
      />
      <div class="review-composer-actions">
        <Button variant="primary" disabled={!body.trim()} onClick={save}>Save note</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function App({ vm, dispatch }: { vm?: ReviewVM; dispatch: ReviewDispatch }) {
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [agent, setAgent] = useState(vm?.agents[0]?.name ?? "");
  const rendered = useMemo(() => (vm?.diff ? renderReviewDiff(vm.diff) : undefined), [vm?.diff]);
  const visibleNew = useMemo(() => visibleNewLinesFrom(rendered?.hunks ?? []), [rendered]);
  const orphans = useMemo(
    () => (vm?.selectedPath ? orphanedNotes(vm.notes, vm.selectedPath, visibleNew) : []),
    [vm, visibleNew],
  );

  if (!vm) {
    return (
      <div class="review-root ds-page">
        <EmptyState kind="loading" message="Loading review…" />
      </div>
    );
  }

  const selected = vm.selectedPath;
  const compare = `${vm.baseRef} ↔ ${vm.currentLabel}`;
  const noteCount = vm.notes.length;
  const canSend = noteCount > 0 && (agent || vm.agents[0]?.name);

  return (
    <div class="review-root ds-page" data-testid="review-root" data-worktree={vm.worktree}>
      <PageChrome
        title="Review"
        hint={`${vm.worktree} · ${compare}`}
        actions={
          <div class="review-send">
            <Select
              data-testid="review-agent"
              value={agent || vm.agents[0]?.name || ""}
              onChange={(event) => setAgent((event.currentTarget as HTMLSelectElement).value)}
              disabled={vm.agents.length === 0}
            >
              {vm.agents.length === 0 ? <option value="">sem agente</option> : null}
              {vm.agents.map((row) => (
                <option key={row.name} value={row.name}>{row.detail ? `${row.name} — ${row.detail}` : row.name}</option>
              ))}
            </Select>
            <Button
              variant="primary"
              data-testid="review-send-batch"
              disabled={!canSend}
              onClick={() => {
                const target = agent || vm.agents[0]?.name;
                if (target) dispatch.sendBatch(target);
              }}
            >
              Submit batch ({noteCount})
            </Button>
          </div>
        }
      />
      {vm.error ? <p class="review-error" data-testid="review-error">{vm.error}</p> : null}
      <div class="review-body">
        <nav class="review-files" aria-label="Files">
          {vm.files.length === 0 ? (
            <p class="review-empty">No files changed.</p>
          ) : vm.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              selected={file.path === selected}
              onSelect={dispatch.selectFile}
            />
          ))}
        </nav>
        <section class="review-pane" aria-label="Diff">
          {!selected ? (
            <EmptyState kind="empty" message="Select a file." />
          ) : vm.diffLoading ? (
            <EmptyState kind="loading" message="Loading diff…" />
          ) : !vm.diff ? (
            <EmptyState kind="empty" message="No diff for this file." />
          ) : vm.diff.binary ? (
            <div class="review-binary" data-testid="review-binary">
              <p>Binary file — no text hunks.</p>
            </div>
          ) : (
            <>
              <header class="review-file-head">
                <span class={`review-file-status st-${vm.diff.status}`}>{vm.diff.status}</span>
                <span class="review-file-path">{vm.diff.from && vm.diff.from !== vm.diff.path ? `${vm.diff.from} → ${vm.diff.path}` : vm.diff.path}</span>
                <span class="review-format">unified</span>
              </header>
              {rendered?.highlightBanner ? (
                <p class="review-banner" data-testid="review-highlight-off" role="status">{rendered.highlightBanner}</p>
              ) : null}
              {orphans.length > 0 ? (
                <aside class="review-orphans" data-testid="review-orphans">
                  <h2>Notes outside the visible diff</h2>
                  {orphans.map((note) => <NoteCard key={note.identity.commentId} note={note} />)}
                </aside>
              ) : null}
              <div class="review-diff" data-testid="review-diff" data-highlight={rendered?.highlight ? "on" : "off"}>
                {rendered?.hunks.length === 0 ? (
                  <p class="review-empty">No hunks (mode-only or identical).</p>
                ) : rendered?.hunks.map((hunk, hi) => (
                  <div key={`${hunk.oldStart}-${hunk.newStart}-${hi}`} class="review-hunk">
                    <div class="review-hunk-head">{hunk.header}</div>
                    {hunk.lines.map((line, li) => {
                      const lineNotes = line.newLine !== null && selected
                        ? notesOnLine(vm.notes, selected, line.newLine)
                        : [];
                      return (
                        <div key={`${hi}-${li}-${line.kind}-${line.oldLine}-${line.newLine}`}>
                          <div class={`review-line kind-${line.kind}${line.annotatable ? "" : " no-annotate"}`}>
                            <span class="review-no">{line.oldLine ?? ""}</span>
                            <span class="review-no">{line.newLine ?? ""}</span>
                            <Ruler
                              line={line}
                              onAnnotate={(newLine) => setDraftLine(newLine)}
                            />
                            <span class="review-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                            <code
                              class={`review-code${rendered.highlight ? " hljs" : ""}`}
                              dangerouslySetInnerHTML={{ __html: line.html }}
                            />
                          </div>
                          {line.noNewline ? <div class="review-nonewline">\ No newline at end of file</div> : null}
                          {lineNotes.map((note) => <NoteCard key={note.identity.commentId} note={note} />)}
                          {draftLine !== null && line.newLine === draftLine && selected ? (
                            <Composer
                              line={draftLine}
                              onSubmit={(body) => {
                                dispatch.upsertNote(selected, draftLine, body);
                                setDraftLine(null);
                              }}
                              onCancel={() => setDraftLine(null)}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
