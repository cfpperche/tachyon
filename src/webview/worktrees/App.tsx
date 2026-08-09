import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { CockpitModel, CockpitWorktreeRow } from "../../cockpit/model";
import { Badge, Button, EmptyState, ListRow, PageChrome } from "../shared/ui";
import type { WorktreesAction, WorktreesStrings as Strings } from "./messages";

/**
 * spec 444 — hygiene classification groups, in action-priority order.
 *
 * t-d29398 — `locked` leads, because it is the only group whose blocking condition makes every other
 * action impossible: Git refuses to remove a locked checkout at all. It is a CLIENT-side split of the
 * engine's `needs-review`, not a fifth engine state — the engine already says why (a `lock` on the
 * classification), and grouping it here is what gives the row its own door instead of a disabled button.
 */
const WT_GROUPS = ["locked", "ready-to-remove", "needs-review", "occupied", "record-only"] as const;
type WtGroup = (typeof WT_GROUPS)[number];
const WT_RECORD_COLLAPSE_AT = 4;

/** Fail-closed: a row the engine did not classify is NEVER treated as safe. */
function wtGroupOf(row: CockpitWorktreeRow): WtGroup {
  const state = row.classification?.state ?? "needs-review";
  // Occupancy still wins: a live agent's lock may belong to a launch in flight, and the thing to do
  // about that row is to deal with the agent, not to take its quarantine away underneath it.
  if (state === "occupied") return "occupied";
  return row.classification?.lock ? "locked" : state;
}

/**
 * t-d29398 — what is actually inside a checkout, shown BEFORE the release button rather than after.
 *
 * This is the whole difference between clearing debris and throwing away work: a quarantined worktree
 * left by a failed launch and one holding somebody's unfinished commits look identical until the row
 * says how many commits it carries and whether the tree is dirty. Fail-closed: with no classification
 * at all it says so, and never renders as "empty".
 */
function InsideSummary({ s, row }: { s: Strings; row: CockpitWorktreeRow }) {
  const c = row.classification;
  const parts = c
    ? [
        c.aheadOfBase > 0 ? s.wtInsideCommits.replace("{0}", String(c.aheadOfBase)) : null,
        c.dirty ? s.wtInsideDirty : s.wtInsideClean,
      ].filter(Boolean)
    : [s.wtInsideUnknown];
  return (
    <span class="ck-wt-inside" data-testid="worktree-inside">
      {s.wtInsideLabel}: {parts.join(" · ")}
    </span>
  );
}

/** t-7cb971 — the check id → its localized label; the sentence beside it is the engine's own. */
const LAND_CHECK_LABEL: Record<string, keyof Strings> = {
  "worktree-clean": "landCheckWorktreeClean",
  "verified-tree": "landCheckVerifiedTree",
  "fast-forward": "landCheckFastForward",
  "primary-on-trunk": "landCheckPrimaryOnTrunk",
  "primary-clean": "landCheckPrimaryClean",
};

/**
 * t-7cb971 — "suggest and copy": for a delivery the trunk does not yet contain, the exact command and
 * the state of every precondition behind it.
 *
 * The checks are shown WHETHER OR NOT they pass, and a green one names what proved it. A list that
 * only ever appeared when something was wrong could not be told apart from a list that was broken —
 * and the point of this block is to be believed by someone who has been burned by running the command
 * by hand. The command itself appears only when every check is green; a blocked delivery gets the
 * reasons and the exits instead, because a command that would fail wastes the reader's time and one
 * that would SUCCEED when it should not is the defect this replaces.
 *
 * Tachyon does not run it. That is stated in the block rather than implied, so nobody goes looking for
 * a button that is deliberately absent.
 */
function LandBlock({
  s,
  land,
  row,
  onCopyText,
  onPost,
}: {
  s: Strings;
  land: NonNullable<CockpitWorktreeRow["land"]>;
  row: CockpitWorktreeRow;
  onCopyText: (text: string) => void;
  onPost: (action: WorktreesAction) => void;
}) {
  const blocked = land.checks.filter((c) => !c.ok);
  const wsHash = row.wsHash ? { wsHash: row.wsHash } : {};
  /**
   * SDD 501 § D2 — what the review will show, in the same words the checks above are written in.
   *
   * `trunkRef..head` is the committed range the land command would introduce, which is the only
   * comparison a land-door review may claim to be about. Named rather than implied: the working-tree
   * comparison the sidebar offers is a legitimate different question, and a human must never have to
   * guess which of the two they are looking at. With no local trunk there is no range to name — the
   * fast-forward check is already red in that case — so it says that instead of inventing a base.
   */
  const compare = land.trunkRef
    ? s.landCompare.replace("{0}", land.trunkRef).replace("{1}", land.head.slice(0, 12))
    : s.landCompareNoTrunk;
  return (
    <section class="ck-land" data-testid="worktree-land">
      <div class="ck-land-head">
        <span class="ck-land-title">{s.landTitle}</span>
        <span class="ck-land-count">
          {land.commits} {s.landCommits} → <span class="ck-mono">{land.trunkRef}</span>
        </span>
      </div>
      <p class="ck-land-intro">{s.landIntro}</p>
      <ul class="ck-land-checks">
        {land.checks.map((check) => (
          <li key={check.id} class={check.ok ? "ck-land-ok" : "ck-land-bad"}>
            <span class="ck-land-mark" aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
            <span class="ck-land-check-body">
              <b>{s[LAND_CHECK_LABEL[check.id] ?? "landTitle"]}</b> — {check.detail}
              {check.fix ? (
                <span class="ck-land-fix">
                  {s.landFixLabel}: {check.fix}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {land.command ? (
        <div class="ck-land-command">
          <span class="ck-land-command-label">{s.landCommandLabel}</span>
          <code class="ck-mono ck-land-command-text">{land.command}</code>
          <Button variant="primary" onClick={() => onCopyText(land.command!)}>
            {s.landCopyCommand}
          </Button>
        </div>
      ) : (
        <p class="ck-land-blocked" role="status">
          {s.landBlocked.replace("{0}", String(blocked.length))}
        </p>
      )}
      {/* SDD 501 — reading the code and proposing it are READ-ONLY doors, so they sit below the
          decision rather than beside it: only "Copy command" is `primary`, and a blocked delivery keeps
          both of these (a red check is when looking matters most). Neither draws a diff — the review
          opens VS Code's own diff editor, through the command the sidebar has always used. */}
      <div class="ck-land-actions">
        <span class="ck-land-compare">{compare}</span>
        <Button variant="default" onClick={() => onPost({ type: "worktreeReviewDiff", id: row.id, ...wsHash })}>
          {s.landReview}
        </Button>
        {land.branch ? (
          <Button variant="default" onClick={() => onPost({ type: "worktreeCreatePr", id: row.id, ...wsHash })}>
            {s.landPropose}
          </Button>
        ) : null}
      </div>
    </section>
  );
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
  s: Strings;
  rows: CockpitWorktreeRow[];
  unavailable?: Array<{ folder: string; reason: string }>;
  onRevealPath: (path: string) => void;
  onCopyText: (text: string) => void;
  onPost: (action: WorktreesAction) => void;
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
    locked: { title: s.wtLockedTitle, desc: s.wtLockedDesc },
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
            {(group === "needs-review" || group === "locked") && reasons.length > 0 ? (
              <span class="ck-wt-reason-warn">⚠ {reasons.join("; ")}</span>
            ) : null}
            {/* t-d29398 — the facts the release decision rests on, in the meta column with the other
                reasons for the same measured reason t-621613 put its notice here: at 360px a sentence
                beside the buttons collapses the row's main column. */}
            {group === "locked" ? <InsideSummary s={s} row={row} /> : null}
            {group === "record-only" ? <span class="ck-wt-reason-muted">{reasons.join("; ")}</span> : null}
            {/* t-621613 — a REASON, so it sits with the other reasons rather than in the actions
                column: measured at 880px, a sentence next to the buttons squeezed the row's main
                column into a four-character strip and wrapped the branch mid-word. */}
            {orphaned ? <span class="ck-wt-reason-muted">{s.wtAgentGone}</span> : null}
          </>
        }
        detail={
          group === "record-only" ? undefined : (
            <>
              {row.path ? <span class="ck-mono">{row.path}</span> : null}
              {/* t-7cb971 — present only when the engine found work the trunk does not contain, so it
                  appears on the rows that actually have something to land, in whichever hygiene group
                  they sit. Absent is never "ready": no block at all is the fail-closed default. */}
              {row.land ? <LandBlock s={s} land={row.land} row={row} onCopyText={onCopyText} onPost={onPost} /> : null}
            </>
          )
        }
        actions={
          /* t-d29398 — the locked arm comes BEFORE the Agent-Studio hand-off, and that ordering is
             the fix. The measured incident was an AGENT's own checkout: sending its owner to
             Studio → Forget offers to erase the agent when all they want is to launch it again, and
             the hand-off exists to protect a checkout from being DELETED by this tab. Releasing a
             quarantine deletes nothing, so nothing it protects is at stake here. */
          group === "locked" ? (
            <>
              <Button
                variant="primary"
                onClick={() => onPost({ type: "worktreeReleaseLock", id: row.id, ...(row.wsHash ? { wsHash: row.wsHash } : {}) })}
              >
                {s.wtReleaseLock}
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
          ) : studioOwned ? (
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

export const defaultStrings: Strings = {
  worktreesTitle: "Managed worktrees",
  worktreesHint: "Tachyon-managed checkouts — reveal and copy paths.",
  agent: "agent",
  change: "change",
  branch: "Branch",
  reveal: "Reveal",
  copyPath: "Copy path",
  noneListed: "Nothing listed for this workspace yet.",
  landTitle: "Land this delivery",
  landIntro: "Tachyon never moves the trunk. When every precondition below is proved, this is the exact command — you run it.",
  landCommandLabel: "Land command",
  landCopyCommand: "Copy command",
  landBlocked: "Not ready to land — {0} precondition(s) not proved. No command is offered: one that would fail wastes your time, and one that would succeed here would land something nobody verified.",
  landCheckWorktreeClean: "Worktree clean",
  landCheckVerifiedTree: "Verified tree",
  landCheckFastForward: "Fast-forward",
  landCheckPrimaryOnTrunk: "Primary checkout on the trunk",
  landCheckPrimaryClean: "Primary checkout clean",
  landFixLabel: "Fix",
  landCommits: "commit(s)",
  landReview: "Review these changes",
  landPropose: "Open a pull request",
  landCompare: "Review shows {0}..{1} — the commits this command would land, not the working tree.",
  landCompareNoTrunk: "No local trunk to compare against — review shows this branch against the ref it was forked from.",
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
  wtLockedTitle: "Preserved — quarantined",
  wtLockedDesc: "A launch was interrupted and Git still holds this checkout. Nothing can reuse or remove it until the lock is released — releasing it deletes nothing.",
  wtReleaseLock: "Release lock",
  wtInsideLabel: "Inside",
  wtInsideClean: "no uncommitted changes",
  wtInsideDirty: "uncommitted changes",
  wtInsideCommits: "{0} commit(s) beyond its base",
  wtInsideUnknown: "contents could not be measured",
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
  return <main class="ds-page"><PageChrome title={s.worktreesTitle} hint={s.worktreesHint} />{model ? <WorktreesHygiene s={s} rows={model.worktrees} unavailable={model.worktreesUnavailable} onRevealPath={(path) => post({ type: "revealPath", path })} onCopyText={(text) => post({ type: "copyText", text })} onPost={post} /> : null}</main>;
}
