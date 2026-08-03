import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { CockpitModel, CockpitWorktreeRow } from "../../cockpit/model";
import type { CockpitStrings } from "../cockpit/messages";
import { Badge, Button, EmptyState, ListRow, PageChrome } from "../shared/ui";
import type { WorktreesAction } from "./messages";

/** spec 444 — hygiene classification groups, in action-priority order. */
const WT_GROUPS = ["ready-to-remove", "needs-review", "occupied", "record-only"] as const;
type WtGroup = (typeof WT_GROUPS)[number];
const WT_RECORD_COLLAPSE_AT = 4;

/** Fail-closed: a row the engine did not classify is NEVER treated as safe. */
function wtGroupOf(row: CockpitWorktreeRow): WtGroup {
  return row.classification?.state ?? "needs-review";
}

function WtGroupHead({ group, title, count, action }: { group: WtGroup; title: string; count: number; action?: ComponentChildren }) {
  return (
    <div class="ck-wt-group-head">
      <span class={`ck-wt-dot ck-wt-dot-${group}`} aria-hidden="true" />
      <span class="ck-wt-group-title">{title}</span>
      <span class="ck-wt-group-count">{count}</span>
      {action ? <span class="ck-wt-group-action">{action}</span> : null}
    </div>
  );
}

/**
 * spec 444 — the Worktrees tab body: classification-grouped rows, per-row blocked reasons, gated
 * actions, and batch cleanup restricted to the two provably-safe groups. All destructive dispatch
 * goes through `onPost` to the host, where the engine re-validates fail-closed per call.
 */
export function WorktreesHygiene({
  s,
  rows,
  unavailable,
  onRevealPath,
  onCopyText,
  onPost,
}: {
  s: CockpitStrings;
  rows: CockpitWorktreeRow[];
  unavailable?: Array<{ folder: string; reason: string }>;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onPost: (action: CockpitAction) => void;
}) {
  const [selected, setSelected] = useState<Record<string, "remove" | "forget">>({});
  const [confirming, setConfirming] = useState(false);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [branchConsent, setBranchConsent] = useState<Record<string, boolean>>({});

  const byGroup = new Map<WtGroup, CockpitWorktreeRow[]>(WT_GROUPS.map((g) => [g, []]));
  for (const row of rows) byGroup.get(wtGroupOf(row))!.push(row);
  // Selection survives model refreshes only while the row is still in its safe group.
  const stillSafe = (id: string, op: "remove" | "forget"): boolean => {
    const row = rows.find((r) => r.id === id);
    return !!row && wtGroupOf(row) === (op === "remove" ? "ready-to-remove" : "record-only");
  };
  const selection = Object.entries(selected).filter(([id, op]) => stillSafe(id, op));
  const toggle = (id: string, op: "remove" | "forget") =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = op;
      return next;
    });
  const selectAll = (group: "ready-to-remove" | "record-only", op: "remove" | "forget") =>
    setSelected((prev) => {
      const next = { ...prev };
      for (const row of byGroup.get(group)!) next[row.id] = op;
      return next;
    });
  const runBatch = () => {
    onPost({
      type: "worktreeBatchCleanup",
      items: selection.map(([id, op]) => {
        const row = rows.find((r) => r.id === id);
        return { id, op, ...(row?.wsHash ? { wsHash: row.wsHash } : {}) };
      }),
    });
    setSelected({});
    setConfirming(false);
  };

  const groupMeta: Record<WtGroup, { title: string; desc: string }> = {
    "ready-to-remove": { title: s.wtReadyTitle, desc: s.wtReadyDesc },
    "needs-review": { title: s.wtReviewTitle, desc: s.wtReviewDesc },
    occupied: { title: s.wtOccupiedTitle, desc: s.wtOccupiedDesc },
    "record-only": { title: s.wtRecordTitle, desc: s.wtRecordDesc },
  };

  const renderRow = (row: CockpitWorktreeRow, group: WtGroup) => {
    const reasons = row.classification?.reasons ?? [];
    // t-e722ce — an agent's checkout is not this tab's to remove. The engine refuses it outright;
    // hiding the control here is so a human is not invited into that refusal, and the row stays
    // VISIBLE because "where did my agent's worktree go" is a question this tab should still answer.
    // t-621613 — unless the agent is PROVED gone. Agent Studio → Forget is reached by name, so it
    // cannot act on an entry whose agent is in no roster and no ledger: pointing a human at it there
    // sends them to a door that is not there, and the checkout ends up cleared by raw git instead.
    // `unknown` keeps the row read-only, exactly as the engine's own authority decision does.
    const orphaned = row.kind === "agent" && row.ownerPresence === "absent";
    const studioOwned = row.kind === "agent" && !orphaned;
    const selectable = !studioOwned && (group === "ready-to-remove" || group === "record-only");
    const op: "remove" | "forget" = group === "ready-to-remove" ? "remove" : "forget";
    const occupant = row.classification?.occupant;
    return (
      <ListRow
        key={row.id}
        leading={
          selectable ? (
            <input
              type="checkbox"
              class="ck-wt-check"
              checked={!!selected[row.id]}
              onChange={() => toggle(row.id, op)}
              aria-label={`${row.slug || row.agent || row.id}`}
            />
          ) : undefined
        }
        title={
          <>
            <span class="name">{row.slug || row.agent || row.id}</span>
            <Badge tone={row.status === "active" ? "ok" : "default"}>{row.status}</Badge>
            <Badge>{row.kind === "agent" ? s.agent : row.kind === "change" ? s.change : row.kind}</Badge>
          </>
        }
        meta={
          <>
            {row.branch ? (
              <span>
                {s.branch}: <span class="ck-mono">{row.branch}</span>
              </span>
            ) : null}
            {row.folder ? <span>{row.folder}</span> : null}
            {group === "occupied" && occupant ? (
              <span class="ck-wt-reason-occupied">
                {s.wtOccupiedBy} <b>{occupant.agent}</b> ({occupant.state})
              </span>
            ) : null}
            {group === "needs-review" && reasons.length > 0 ? (
              <span class="ck-wt-reason-warn">⚠ {reasons.join("; ")}</span>
            ) : null}
            {group === "record-only" ? <span class="ck-wt-reason-muted">{reasons.join("; ")}</span> : null}
            {/* t-621613 — a REASON, so it sits with the other reasons rather than in the actions
                column: measured at 880px, a sentence next to the buttons squeezed the row's main
                column into a four-character strip and wrapped the branch mid-word. */}
            {orphaned ? <span class="ck-wt-reason-muted">{s.wtAgentGone}</span> : null}
          </>
        }
        detail={group !== "record-only" && row.path ? <span class="ck-mono">{row.path}</span> : undefined}
        actions={
          studioOwned ? (
            <>
              <span class="ck-wt-reason-muted">{s.wtAgentOwned}</span>
              {row.path ? (
                <Button variant="default" onClick={() => onRevealPath(row.path)}>
                  {s.reveal}
                </Button>
              ) : null}
            </>
          ) : group === "record-only" ? (
            <Button variant="default" onClick={() => onPost({ type: "worktreeForgetRecord", id: row.id, ...(row.wsHash ? { wsHash: row.wsHash } : {}) })}>
              {s.wtForgetRecord}
            </Button>
          ) : group === "ready-to-remove" ? (
            <>
              {row.tachyonCreatedBranch ? (
                <label class="ck-wt-branch-consent">
                  <input
                    type="checkbox"
                    checked={!!branchConsent[row.id]}
                    onChange={() => setBranchConsent((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                  />
                  {s.wtAlsoDeleteBranch}
                </label>
              ) : null}
              <Button
                variant="default"
                onClick={() =>
                  onPost({
                    type: "worktreeRemove",
                    id: row.id,
                    ...(branchConsent[row.id] ? { deleteBranch: true } : {}),
                    ...(row.wsHash ? { wsHash: row.wsHash } : {}),
                  })
                }
              >
                {s.wtRemoveCheckout}
              </Button>
              <Button variant="default" onClick={() => onRevealPath(row.path)}>
                {s.reveal}
              </Button>
            </>
          ) : (
            <>
              <Button variant="default" disabled title={`${s.wtBlocked}: ${reasons.join("; ") || group}`}>
                {s.wtRemoveCheckout}
              </Button>
              {row.path ? (
                <>
                  <Button variant="default" onClick={() => onRevealPath(row.path)}>
                    {s.reveal}
                  </Button>
                  <Button variant="default" onClick={() => onCopyText(row.path)}>
                    {s.copyPath}
                  </Button>
                </>
              ) : null}
            </>
          )
        }
      />
    );
  };

  const recordRows = byGroup.get("record-only")!;
  const visibleRecords = showAllRecords ? recordRows : recordRows.slice(0, WT_RECORD_COLLAPSE_AT);

  return (
    <div data-testid="control-worktrees">
      {unavailable && unavailable.length > 0 ? (
        <div class="ck-wt-unavailable" role="alert">
          {s.wtEngineUnavailable}
          {unavailable.map((u) => (
            <div key={u.folder} class="ck-mono ck-wt-unavailable-detail">
              {u.folder}: {u.reason}
            </div>
          ))}
        </div>
      ) : null}
      {rows.length === 0 && (!unavailable || unavailable.length === 0) ? (
        <EmptyState kind="empty" message={s.noneListed} />
      ) : null}
      {WT_GROUPS.map((group) => {
        const groupRows = group === "record-only" ? visibleRecords : byGroup.get(group)!;
        const total = byGroup.get(group)!.length;
        if (total === 0) return null;
        return (
          <section key={group} class="ck-wt-group">
            <WtGroupHead
              group={group}
              title={groupMeta[group].title}
              count={total}
              action={
                group === "ready-to-remove" || group === "record-only" ? (
                  <Button variant="default" onClick={() => selectAll(group, group === "ready-to-remove" ? "remove" : "forget")}>
                    {s.wtSelectAll}
                  </Button>
                ) : undefined
              }
            />
            <p class="ck-wt-group-desc">{groupMeta[group].desc}</p>
            <div class="ck-card-list">
              {groupRows.map((row) => renderRow(row, group))}
              {group === "record-only" && !showAllRecords && recordRows.length > WT_RECORD_COLLAPSE_AT ? (
                <button class="ck-wt-show-all" onClick={() => setShowAllRecords(true)}>
                  {s.wtShowAll} ({recordRows.length})
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
      {selection.length > 0 && !confirming ? (
        <div class="ck-wt-batch-bar">
          <span>
            <b>{selection.length}</b> {s.wtSelected}
          </span>
          <Button variant="default" onClick={() => setSelected({})}>
            {s.wtClearSelection}
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)}>
            {s.wtReviewConfirm}
          </Button>
        </div>
      ) : null}
      {confirming && selection.length > 0 ? (
        <div class="ck-wt-confirm" role="dialog" aria-modal="true">
          <div class="ck-wt-confirm-card">
            <h3>{s.wtConfirmTitle}</h3>
            <p>{s.wtConfirmBody}</p>
            <ul>
              {selection.map(([id, op]) => {
                const row = rows.find((r) => r.id === id);
                return (
                  <li key={id}>
                    {row?.slug || row?.agent || id} — {op === "remove" ? s.wtRemoveCheckout : s.wtForgetRecord}
                  </li>
                );
              })}
            </ul>
            <div class="ck-wt-confirm-actions">
              <Button variant="default" onClick={() => setConfirming(false)}>
                {s.wtCancel}
              </Button>
              <Button variant="primary" onClick={runBatch}>
                {s.wtConfirmRun}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type Strings = Pick<CockpitStrings, "worktreesTitle" | "worktreesHint" | "agent" | "change" | "branch" | "reveal" | "copyPath" | "noneListed" | "wtAgentGone" | "wtAgentOwned" | "wtAlsoDeleteBranch" | "wtBlocked" | "wtCancel" | "wtClearSelection" | "wtConfirmBody" | "wtConfirmRun" | "wtConfirmTitle" | "wtEngineUnavailable" | "wtForgetRecord" | "wtOccupiedBy" | "wtOccupiedDesc" | "wtOccupiedTitle" | "wtReadyDesc" | "wtReadyTitle" | "wtRecordDesc" | "wtRecordTitle" | "wtRemoveCheckout" | "wtReviewConfirm" | "wtReviewDesc" | "wtReviewTitle" | "wtSelectAll" | "wtSelected" | "wtShowAll">;
export const defaultStrings: Strings = {
  worktreesTitle: "Managed worktrees",
  worktreesHint: "Tachyon-managed checkouts — reveal and copy paths.",
  agent: "agent",
  change: "change",
  branch: "Branch",
  reveal: "Reveal",
  copyPath: "Copy path",
  noneListed: "Nothing listed for this workspace yet.",
  wtAgentGone: "Agent no longer exists — leftover checkout",
  wtAgentOwned: "Managed by Agent Studio → Forget",
  wtAlsoDeleteBranch: "Also delete local branch",
  wtBlocked: "Blocked",
  wtCancel: "Cancel",
  wtClearSelection: "Clear",
  wtConfirmBody: "Each entry is re-checked at execution — one whose state changed is skipped with a reason, the rest proceed.",
  wtConfirmRun: "Run cleanup",
  wtConfirmTitle: "Confirm cleanup",
  wtEngineUnavailable: "Engine unavailable — registry not shown (unverified data is never displayed).",
  wtForgetRecord: "Forget record",
  wtOccupiedBy: "occupied by",
  wtOccupiedDesc: "A live agent holds this checkout right now.",
  wtOccupiedTitle: "Occupied",
  wtReadyDesc: "Clean, unoccupied, and every commit is already in its base branch. Safe to delete.",
  wtReadyTitle: "Ready to remove",
  wtRecordDesc: "The registry row survives, but the checkout's directory is gone. Nothing to reveal — just forget the row.",
  wtRecordTitle: "Record-only",
  wtRemoveCheckout: "Remove checkout",
  wtReviewConfirm: "Review & confirm…",
  wtReviewDesc: "Blocked from cleanup — read the reason before touching these by hand.",
  wtReviewTitle: "Needs review",
  wtSelectAll: "Select all",
  wtSelected: "selected",
  wtShowAll: "Show all",
};
export function App({ model, strings: s, post }: { model?: CockpitModel; strings: Strings; post: (action: WorktreesAction) => void }) {
  return <main><PageChrome title={s.worktreesTitle} hint={s.worktreesHint} />{model ? <WorktreesHygiene s={s as CockpitStrings} rows={model.worktrees} unavailable={model.worktreesUnavailable} onRevealPath={(path) => post({ type: "revealPath", path })} onCopyText={(text) => post({ type: "copyText", text })} onPost={(action) => post(action as WorktreesAction)} /> : null}</main>;
}
