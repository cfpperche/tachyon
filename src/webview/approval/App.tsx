import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ApprovalViewModel, ApprovalViewItem } from "./viewModel";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

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
          <button type="button" title="Approve" aria-label={`Approve ${item.id}`} disabled={item.tampered} onClick={() => dispatch.resolve(item.id, "approved")}>
            <Icon name="check" />
          </button>
          <button type="button" title="Deny" aria-label={`Deny ${item.id}`} disabled={item.tampered} onClick={() => dispatch.resolve(item.id, "denied")}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {item.tampered && <div class="approval-warning"><Icon name="warning" /> {item.warning ?? "payloadHash mismatch; approval is blocked"}</div>}
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
        <div class="approval-empty"><Icon name="loading" /> Loading approvals...</div>
      </div>
    );
  }
  return (
    <div class="approval-root">
      <header class="approval-title">
        <div>
          <h1>Human approvals</h1>
          <p>{vm.folder}</p>
        </div>
        <button type="button" title="Refresh" aria-label="Refresh approvals" onClick={() => dispatch.refresh()}><Icon name="refresh" /></button>
      </header>
      {error && <div class="approval-warning"><Icon name="error" /> {error}</div>}
      {vm.approvals.length === 0 ? (
        <div class="approval-empty">No pending approvals</div>
      ) : (
        <div class="approval-list">
          {vm.approvals.map((item) => <ApprovalCard key={item.id} item={item} dispatch={dispatch} />)}
        </div>
      )}
    </div>
  );
}
