import type { ApprovalDecision } from "@tachyon/engine/bridge/approvalRequest.js";
import type { ApprovalViewModel, ApprovalViewItem } from "./viewModel";
import { Button, EmptyState, PageChrome } from "../shared/ui";

export interface ApprovalDispatch {
  refresh(): void;
  resolve(id: string, decision: ApprovalDecision): void;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div class="approval-field">
      <div class="approval-label">{label}</div>
      <pre>{value}</pre>
    </div>
  );
}

function ApprovalCard({ item, dispatch }: { item: ApprovalViewItem; dispatch: ApprovalDispatch }) {
  return (
    <article class={`approval-card${item.tampered ? " blocked" : ""}`}>
      <header class="approval-head">
        <div>
          <h2>{item.id}</h2>
          <div class="approval-provenance">
            <span>{item.requester}</span>
            <span>{item.session}</span>
            <span>{item.createdAt}</span>
          </div>
        </div>
        <div class="approval-actions">
          <Button
            variant="primary"
            icon="check"
            title="Approve"
            aria-label={`Approve ${item.id}`}
            disabled={item.tampered}
            onClick={() => dispatch.resolve(item.id, "approved")}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            icon="close"
            title="Deny"
            aria-label={`Deny ${item.id}`}
            disabled={item.tampered}
            onClick={() => dispatch.resolve(item.id, "denied")}
          >
            Deny
          </Button>
        </div>
      </header>
      {item.tampered && (
        <div class="approval-warning">
          payloadHash mismatch; approval is blocked{item.warning ? ` — ${item.warning}` : ""}
        </div>
      )}
      <section class="approval-payload" aria-label={`Verbatim payload for ${item.id}`}>
        <Field label="reason" value={item.payload.reason} />
        <Field label="proposed_action" value={item.payload.proposedAction} />
        <Field label="risk" value={item.payload.risk} />
        <Field label="exact_prompt" value={item.payload.exactPrompt} />
      </section>
    </article>
  );
}

export function App({ vm, error, dispatch }: { vm?: ApprovalViewModel; error?: string; dispatch: ApprovalDispatch }) {
  if (!vm) {
    return (
      <div class="approval-root">
        <EmptyState kind="loading" message="Loading approvals…" />
      </div>
    );
  }
  return (
    <div class="approval-root">
      <PageChrome
        title="Approvals"
        hint={vm.folder}
        actions={<Button icon="refresh" title="Refresh approvals" onClick={() => dispatch.refresh()}>Refresh</Button>}
      />
      {error ? <div class="approval-warning">{error}</div> : null}
      {vm.approvals.length === 0 ? (
        <EmptyState kind="empty" message="No pending approvals" />
      ) : (
        <div class="approval-list">
          {vm.approvals.map((item) => (
            <ApprovalCard key={item.id} item={item} dispatch={dispatch} />
          ))}
        </div>
      )}
    </div>
  );
}
