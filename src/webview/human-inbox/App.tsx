import { useState } from "preact/hooks";
import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ValidationOutcome } from "../../validations/types";
import type { HumanInboxItem, HumanInboxKind } from "../../humanInbox/model";
import type { SavedAgentProposalReview } from "../../agents/savedAgentProposalReview";
import type { InboxArtifactPreview } from "../../humanInbox/artifacts";
import type { HumanInboxViewModel, HumanInboxItemViewModel } from "./viewModel";
import { Badge, Button, EmptyState, Icon, IconButton, PageChrome, Select, Textarea } from "../shared/ui";

/**
 * Human Inbox — one surface for everything waiting on a human (t-e76acc).
 *
 * Two components, one wire: `App` is the aggregated LIST (the section), `ItemApp` is the DETAIL route
 * that opens one row. They are the "single navigation and count" the ratified direction asks for —
 * and nothing more than that. Every action below dispatches into the kind's own existing path; this
 * file resolves nothing itself, which is the client half of "a router, not a resolver".
 */

export interface HumanInboxDispatch {
  refresh(): void;
  open(kind: HumanInboxKind, id: string): void;
  /** approval-only — the capability path; there is no validation caller for this by construction */
  resolveApproval(id: string, decision: ApprovalDecision): void;
  closeValidation(id: string, outcome: ValidationOutcome, note: string): void;
  assignValidation(id: string, assignee: string, expect: { assignee: string | null; updatedAt: string }): void;
  /** SDD 482 phase 4C — carries the DIGEST that was rendered, so a changed proposal cannot be approved. */
  decideSavedAgentProposal(id: string, digest: string, decision: "approve" | "deny", reason?: string): void;
}

/** "3h" / "2d" — how long this has been waiting, which is the thing a human scans the list for. */
function age(createdAt: string, now = Date.now()): string {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return "—";
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function KindBadge({ kind }: { kind: HumanInboxKind }) {
  // An approval BLOCKS an agent; a validation is evidence waiting to be read; a Saved Agent proposal
  // blocks nobody but CREATES durable authority. Different weights, and the badge says which — the row
  // must never read as "some generic thing to click", and a proposal must never read as a validation.
  if (kind === "approval") return <Badge tone="warn">approval</Badge>;
  if (kind === "saved-agent-proposal") return <Badge tone="warn">new Saved Agent</Badge>;
  return <Badge tone="info">validation</Badge>;
}

/**
 * Who is waiting, and how much that name can be trusted.
 *
 * An approval's requester is Bridge-resolved (unforgeable by construction); a validation's assignee is
 * self-declared text. The report measured that asymmetry and this surface refuses to flatten it — an
 * aggregated list is exactly where two different kinds of provenance would otherwise start to look
 * like one.
 */
function Requester({ item }: { item: HumanInboxItem }) {
  return (
    <span class="hi-requester" title={item.requesterTrust === "bridge-resolved" ? "identity resolved by the Bridge" : "self-declared, not verified"}>
      {item.requester}
      {item.requesterTrust === "self-declared" ? <span class="hi-trust">· self-declared</span> : null}
    </span>
  );
}

function InboxRow({ item, dispatch }: { item: HumanInboxItem; dispatch: HumanInboxDispatch }) {
  return (
    <button
      type="button"
      class={`hi-row${item.warning ? " warned" : ""}`}
      data-testid={`inbox-row-${item.kind}-${item.id}`}
      onClick={() => dispatch.open(item.kind, item.id)}
    >
      <span class="hi-row-top">
        <KindBadge kind={item.kind} />
        <span class="hi-title">{item.title}</span>
        {item.stale ? <Badge tone="warn" title="waiting longer than a day">stale</Badge> : null}
      </span>
      <span class="hi-row-meta">
        <span class="hi-id">{item.id}</span>
        <Requester item={item} />
        <span class="hi-age">{age(item.createdAt)}</span>
        {item.artifacts.length > 0 ? (
          <span class="hi-artifacts">
            <Icon name="file-media" /> {item.artifacts.length}
          </span>
        ) : null}
      </span>
      {item.warning ? <span class="hi-row-warning">{item.warning}</span> : null}
    </button>
  );
}

export function App({ vm, error, dispatch }: { vm?: HumanInboxViewModel; error?: string; dispatch: HumanInboxDispatch }) {
  if (!vm) {
    return (
      <div class="hi-root">
        <EmptyState kind="loading" message="Loading inbox…" />
      </div>
    );
  }
  const { counts } = vm;
  return (
    <div class="hi-root" data-testid="control-human-inbox">
      <PageChrome
        title="Human Inbox"
        hint={vm.folder}
        actions={<IconButton name="refresh" title="Refresh inbox" onClick={() => dispatch.refresh()} />}
      />
      {/* One count, derived from the rows themselves — never a shell-side constant. A security
          counter that reads zero while requests sit on disk is worse than no counter (report § 4.1). */}
      <div class="hi-counts" data-testid="inbox-counts">
        <span class={counts.total > 0 ? "hi-count strong" : "hi-count"}>{counts.total} waiting</span>
        <span class="hi-count">{counts.approvals} approvals</span>
        <span class="hi-count">{counts.validations} validations</span>
        {counts.stale > 0 ? <span class="hi-count warn">{counts.stale} stale</span> : null}
      </div>
      {error ? (
        <div class="hi-error" role="alert">
          <Icon name="error" /> {error}
        </div>
      ) : null}
      {vm.items.length === 0 ? (
        <EmptyState kind="empty" message="Nothing is waiting on you" />
      ) : (
        <div class="hi-list">
          {vm.items.map((item) => (
            <InboxRow key={`${item.kind}:${item.id}`} item={item} dispatch={dispatch} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── detail route ─────────────────────────────────────────────────────────────────────────────── */

/**
 * One artifact, shown the way this product already shows that kind of thing.
 *
 * Images render from a host-loaded source (pin preview's contract); an HTML prototype renders in a
 * sandboxed srcdoc iframe (Task detail's PrototypePreview contract). A link or a plain reference is
 * NOT a failure and does not get an error tone — it is simply text, which is all it ever was. An
 * unavailable artifact keeps its name and states its reason: the human learns the evidence is gone,
 * rather than learning nothing.
 */
function ArtifactStage({ artifact }: { artifact: InboxArtifactPreview }) {
  return (
    <figure class="hi-stage" data-testid={`inbox-artifact-${artifact.id}`}>
      {artifact.src ? (
        <img class="hi-stage-image" src={artifact.src} alt={artifact.name} />
      ) : artifact.srcdoc ? (
        <div class="hi-stage-proto">
          <iframe title={`Static prototype: ${artifact.name}`} sandbox="" srcDoc={artifact.srcdoc} tabIndex={-1} />
          <span class="hi-stage-watermark" aria-hidden="true">UNTRUSTED · STATIC</span>
        </div>
      ) : artifact.available ? (
        <div class="hi-stage-plain">
          <Icon name={artifact.kind === "link" ? "link" : "references"} />
          <code>{artifact.ref.ref}</code>
        </div>
      ) : (
        <div class="hi-stage-missing" role="note">
          <Icon name="warning" /> {artifact.reason ?? "cannot be shown"}
        </div>
      )}
      <figcaption class="hi-stage-caption">
        <strong>{artifact.name}</strong>
        <span class="hi-dim">{artifact.detail}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The evidence attached to an item.
 *
 * With several artifacts the human steps through them HERE — a picker plus prev/next, never a file to
 * download and never leaving the inbox, which is what the task asks for in as many words. With none,
 * the section still renders and says "no artifacts attached": silence would let an item with no
 * evidence look exactly like an item whose evidence was checked.
 */
function Artifacts({ vm }: { vm: HumanInboxItemViewModel }) {
  const [index, setIndex] = useState(0);
  const artifacts = vm.artifacts;
  const current = artifacts[Math.min(index, artifacts.length - 1)];
  const summary = vm.artifactSummary;
  return (
    <section class="hi-evidence" aria-label="Attached evidence" data-testid="inbox-artifacts">
      <header class="hi-evidence-head">
        <h3>Evidence</h3>
        {summary.total === 0 ? (
          <span class="hi-dim" data-testid="inbox-artifacts-empty">no artifacts attached</span>
        ) : (
          <span class="hi-dim">
            {summary.total} attached
            {summary.unavailable > 0 ? ` · ${summary.unavailable} unavailable` : ""}
          </span>
        )}
      </header>
      {artifacts.length > 1 ? (
        <div class="hi-picker">
          <IconButton name="chevron-left" title="Previous artifact" onClick={() => setIndex((i) => (i - 1 + artifacts.length) % artifacts.length)} />
          <div class="hi-picker-strip">
            {artifacts.map((artifact, i) => (
              <button
                type="button"
                key={artifact.id}
                class={`hi-chip${i === index ? " active" : ""}${artifact.available ? "" : " gone"}`}
                aria-current={i === index}
                onClick={() => setIndex(i)}
              >
                {artifact.name}
              </button>
            ))}
          </div>
          <IconButton name="chevron-right" title="Next artifact" onClick={() => setIndex((i) => (i + 1) % artifacts.length)} />
        </div>
      ) : null}
      {current ? <ArtifactStage artifact={current} /> : null}
    </section>
  );
}

function ApprovalDetail({ item, dispatch }: { item: Extract<HumanInboxItem["detail"], { kind: "approval" }>["approval"]; dispatch: HumanInboxDispatch }) {
  return (
    <>
      {item.tampered ? (
        <div class="hi-error" role="alert">
          payloadHash mismatch; approval is blocked{item.warning ? ` — ${item.warning}` : ""}
        </div>
      ) : null}
      {/* Verbatim, in full, ABOVE the buttons: a human approves what the requester actually wrote,
          never a summary of it. */}
      <section class="hi-payload" aria-label={`Verbatim payload for ${item.id}`}>
        {([
          ["reason", item.payload.reason],
          ["proposed_action", item.payload.proposedAction],
          ["risk", item.payload.risk],
          ["exact_prompt", item.payload.exactPrompt],
        ] as const).map(([label, value]) => (
          <div class="hi-field" key={label}>
            <div class="hi-field-label">{label}</div>
            <pre>{value}</pre>
          </div>
        ))}
      </section>
      <div class="hi-decision">
        <Button
          variant="primary"
          icon="check"
          disabled={item.tampered}
          data-testid="inbox-approve"
          onClick={() => dispatch.resolveApproval(item.id, "approved")}
        >
          Approve
        </Button>
        <Button variant="danger" icon="close" disabled={item.tampered} onClick={() => dispatch.resolveApproval(item.id, "denied")}>
          Deny
        </Button>
      </div>
    </>
  );
}

function ValidationDetail({
  item,
  dispatch,
}: {
  item: Extract<HumanInboxItem["detail"], { kind: "validation" }>["validation"];
  dispatch: HumanInboxDispatch;
}) {
  const [outcome, setOutcome] = useState<ValidationOutcome>("passed");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(item.assignee ?? "");
  return (
    <>
      <div class="hi-chips">
        {item.type ? <Badge>{item.type}</Badge> : null}
        <Badge tone="info">{item.status}</Badge>
        <Badge>{item.executor}</Badge>
        {item.priority !== undefined ? <Badge>P{item.priority}</Badge> : null}
      </div>
      {item.instructions ? (
        <section class="hi-field">
          <div class="hi-field-label">instructions</div>
          <pre>{item.instructions}</pre>
        </section>
      ) : null}
      {item.rounds.length > 0 ? (
        <section class="hi-rounds">
          <h3>Rounds</h3>
          <ol>
            {item.rounds.map((round) => (
              <li key={round.n}>
                <strong>Round {round.n}</strong>
                {round.outcome ? ` · ${round.outcome}` : ""}
                {round.assignee ? ` · ${round.assignee}` : ""}
                {round.resultNote ? <p>{round.resultNote}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <div class="hi-decision">
        <label class="hi-assign">
          Assignee
          <input value={assignee} maxlength={64} placeholder="human or agent" onInput={(e) => setAssignee(e.currentTarget.value)} />
        </label>
        <Button
          variant="default"
          disabled={!assignee.trim() || assignee.trim() === item.assignee}
          onClick={() => dispatch.assignValidation(item.id, assignee.trim(), { assignee: item.assignee ?? null, updatedAt: item.updatedAt })}
        >
          Claim / assign
        </Button>
      </div>
      <div class="hi-close">
        <Select value={outcome} aria-label="Outcome" onChange={(e) => setOutcome((e.currentTarget as HTMLSelectElement).value as ValidationOutcome)}>
          <option value="passed">passed</option>
          <option value="failed">failed</option>
          <option value="skipped">skipped</option>
        </Select>
        <Textarea value={note} placeholder="Required result note" onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)} />
        <Button variant="primary" disabled={!note.trim()} data-testid="inbox-close-validation" onClick={() => dispatch.closeValidation(item.id, outcome, note.trim())}>
          Close validation
        </Button>
      </div>
    </>
  );
}

/**
 * SDD 482 phase 4C — the pane a human decides a Saved Agent on.
 *
 * Two properties are load-bearing and are why this is not a generic key/value dump:
 *
 *  - APPROVE CARRIES THE DIGEST that was rendered. If the proposal changed between this render and the
 *    click, the commit path refuses rather than approving whatever is on disk now. The button is
 *    disabled outright once the base has diverged, so the refusal is visible before it happens rather
 *    than as a failure afterwards.
 *  - ENVIRONMENT SHOWS NAMES, NEVER VALUES. The view model already strips them; the renderer has no
 *    field to leak. Stated here too because "the other layer handles it" is how both layers end up
 *    assuming the other did.
 */
function SavedAgentProposalDetail({
  proposal,
  dispatch,
}: {
  proposal: SavedAgentProposalReview;
  dispatch: HumanInboxDispatch;
}) {
  const [reason, setReason] = useState("");
  return (
    <div class="hi-proposal" data-testid="inbox-saved-agent-proposal">
      <p class="hi-proposal-rationale">{proposal.rationale}</p>
      <dl class="hi-proposal-facts">
        <dt>Agent</dt><dd data-testid="proposal-agent-name">{proposal.agentName}</dd>
        <dt>Runtime</dt><dd>{proposal.runtime.adapter}{proposal.runtime.executable ? ` (${proposal.runtime.executable})` : ""}</dd>
        {/* t-4071e4 — WHERE it runs is a fact the human decides on, not a footnote. It sits in the
          * scannable list because the approval that broke this shipped an agent into the shared
          * checkout with nothing on screen saying so. The detail (and the opt-out warning) is below. */}
        <dt>Workspace</dt>
        <dd data-testid="proposal-workspace">
          {proposal.worktreeEnabled === "unknown"
            ? "(unreadable)"
            : proposal.worktreeEnabled
              ? "Its own isolated git worktree"
              : <>Shared workspace checkout <Badge tone="warn">not isolated</Badge></>}
        </dd>
        <dt>Proposed by</dt><dd>{proposal.proposer} <Badge tone="info">Bridge-resolved</Badge></dd>
        <dt>Expires</dt><dd>{proposal.expiresAt}</dd>
        <dt>Digest</dt><dd class="hi-proposal-digest">{proposal.digest.slice(0, 16)}…</dd>
      </dl>

      {proposal.dangerous.length > 0 ? (
        <div class="hi-proposal-dangerous" data-testid="proposal-dangerous">
          <h3>What this grants</h3>
          <ul>
            {proposal.dangerous.map((entry) => (
              <li key={entry.label}><strong>{entry.label}</strong>: {entry.detail}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p class="hi-proposal-plain" data-testid="proposal-dangerous-none">
          This proposal requests no ownership, MCP servers, hooks or environment.
        </p>
      )}

      {proposal.environmentNames.length > 0 ? (
        <p class="hi-proposal-env">
          Environment variables requested (names only): {proposal.environmentNames.join(", ")}
        </p>
      ) : null}

      <div class="hi-proposal-affected">
        <h3>What approving writes</h3>
        <ul>{proposal.affected.map((entry) => <li key={entry}>{entry}</li>)}</ul>
        <p class="hi-proposal-note" data-testid="proposal-created-enabled-note">
          Created enabled; not started — launching stays a separate action after approval.
        </p>
      </div>

      <div class="hi-proposal-decide">
        <Textarea
          value={reason}
          placeholder="Reason (required to deny)"
          onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)}
        />
        <Button
          variant="primary"
          data-testid="inbox-approve-saved-agent"
          disabled={proposal.baseDiverged || proposal.expired}
          onClick={() => dispatch.decideSavedAgentProposal(proposal.id, proposal.digest, "approve")}
        >
          Approve and create
        </Button>
        <Button
          variant="default"
          data-testid="inbox-deny-saved-agent"
          disabled={!reason.trim()}
          onClick={() => dispatch.decideSavedAgentProposal(proposal.id, proposal.digest, "deny", reason.trim())}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ItemApp({
  vm,
  missing,
  dispatch,
}: {
  vm?: HumanInboxItemViewModel;
  missing?: { kind: HumanInboxKind; id: string };
  dispatch: HumanInboxDispatch;
}) {
  // Gone-while-you-were-reading is its own state, never a blank document: something else resolved or
  // closed this, and saying so is the difference between "handled" and "lost".
  if (missing) {
    return (
      <div class="hi-root">
        <EmptyState kind="empty" message={`${missing.kind} ${missing.id} is no longer waiting — it was resolved or closed elsewhere.`} />
      </div>
    );
  }
  if (!vm) {
    return (
      <div class="hi-root">
        <EmptyState kind="loading" message="Loading item…" />
      </div>
    );
  }
  // Computed inline, not memoized: this component returns early above (missing / not-yet-loaded), so
  // a hook here would run conditionally.
  const item = vm.item;
  const waited = age(item.createdAt);
  return (
    <div class="hi-root hi-detail" data-testid="control-human-inbox-item">
      <PageChrome title={item.title} hint={`${item.id} · ${vm.folder}`} />
      <div class="hi-detail-meta">
        <KindBadge kind={item.kind} />
        <Requester item={item} />
        <span class="hi-age" title={item.createdAt}>waiting {waited}</span>
        {item.stale ? <Badge tone="warn">stale</Badge> : null}
      </div>
      {item.warning && item.detail.kind !== "approval" ? (
        <div class="hi-error" role="alert">{item.warning}</div>
      ) : null}
      {item.detail.kind === "approval" ? (
        <ApprovalDetail item={item.detail.approval} dispatch={dispatch} />
      ) : item.detail.kind === "saved-agent-proposal" ? (
        <SavedAgentProposalDetail proposal={item.detail.proposal} dispatch={dispatch} />
      ) : (
        <ValidationDetail item={item.detail.validation} dispatch={dispatch} />
      )}
      <Artifacts vm={vm} />
    </div>
  );
}
