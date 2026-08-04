import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, ItemApp, type HumanInboxDispatch } from "./App";
import type { HumanInboxViewModel, HumanInboxItemViewModel } from "./viewModel";
import type { HumanInboxKind } from "../../humanInbox/model";
import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ValidationOutcome } from "../../validations/types";
import {
  HUMAN_INBOX,
  HUMAN_INBOX_ERROR,
  HUMAN_INBOX_ITEM,
  HUMAN_INBOX_ITEM_MISSING,
  assignInboxValidationAction,
  closeInboxItemAction,
  closeInboxValidationAction,
  decideSavedAgentProposalAction,
  decideSavedAgentRemovalAction,
  decideScheduleProposalAction,
  openInboxItemAction,
  pollInboxAction,
  readyMessage,
  refreshInboxAction,
  resolveInboxApprovalAction,
  type HumanInboxErrorReceipt,
} from "./messages";

/**
 * SDD 485 D4 — the Human Inbox app's OWN bootstrap.
 *
 * `./App` exports the two components Control embedded, and what changed is who mounts them: `cockpit/App.tsx`
 * no longer lazy-imports either, so there is exactly one live renderer of this screen and one client that can
 * answer a host push.
 *
 * ## The subroute is the HOST's, and this client only reflects it
 *
 * Control decided list-vs-item from `model.activeRoute` — its router's state, pushed down with every model.
 * The app has no router, and the temptation is to give the client one (a local `mode` it flips on click).
 * That would be a second authority: the host already owns the open item (it is per-panel state inside `bind`,
 * because a dashboard has one panel per project), and it decides on every send whether this panel is showing
 * a queue or an item. So the client's rule is exactly "render what last arrived" — a list message means the
 * list, an item message means the item — and a click POSTS rather than navigates.
 *
 * That is what makes the deep link, the row click, the Back button and a terminal decision (which returns to
 * the queue) all reach the screen through one path instead of four, and it is why an item that vanished while
 * being read can be answered by the host simply posting the list again.
 *
 * Two things this file gains that the Control embed borrowed from its host:
 *
 *  - its own 3s poll. Inside Control the model was re-posted by CONTROL's shell poll, which re-ran the active
 *    section's module every 3 seconds; standing alone the app owns that timer. It sends `POLL`, NOT
 *    `refreshInbox` — see the note on `POLL` in `messages.ts`: here the two happen to do the same work, and
 *    they are kept apart so that a later side effect on the human's button cannot silently acquire a caller
 *    that runs twenty times a minute. The timer is gated again HOST-side while the tab is hidden
 *    (`humanInboxRefreshKind` → `PanelWorkGate`), so the client cannot reopen that door whatever it does;
 *  - its own error boundary, which is the per-app failure isolation `spec.md` reversed the app count for.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (message: unknown): void => {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
};

function HumanInboxRoot() {
  const [vm, setVm] = useState<HumanInboxViewModel | undefined>(undefined);
  const [itemVm, setItemVm] = useState<HumanInboxItemViewModel | undefined>(undefined);
  const [missing, setMissing] = useState<{ kind: HumanInboxKind; id: string } | undefined>(undefined);
  const [error, setError] = useState<HumanInboxErrorReceipt | undefined>(undefined);
  /** which surface this panel is showing — set by the HOST's last push, never by a click. */
  const [showing, setShowing] = useState<"list" | "item">("list");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as Record<string, unknown> | undefined;
      if (!raw || typeof raw.type !== "string") return;
      if (raw.type === HUMAN_INBOX && raw.vm) {
        setVm(raw.vm as HumanInboxViewModel);
        // A list push is the host saying "you are on the queue" — the terminal-decision return path and the
        // vanished-item recovery both arrive this way, and both must clear the item they were showing.
        setShowing("list");
        setItemVm(undefined);
        setMissing(undefined);
      } else if (raw.type === HUMAN_INBOX_ITEM && raw.vm) {
        setItemVm(raw.vm as HumanInboxItemViewModel);
        setMissing(undefined);
        setShowing("item");
      } else if (raw.type === HUMAN_INBOX_ITEM_MISSING) {
        setMissing({ kind: raw.kind as HumanInboxKind, id: String(raw.id ?? "") });
        setItemVm(undefined);
        setShowing("item");
      } else if (raw.type === HUMAN_INBOX_ERROR) {
        // t-58f9e9 — a fresh RECEIPT object every time, never the bare string: two identical refusals in a
        // row are indistinguishable to `useState`, which bails on an equal value, and the detail pane's
        // effect that re-enables Approve/Deny would never run again.
        setError({ message: String(raw.message ?? "") });
      }
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => post(pollInboxAction()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  const dispatch = useMemo<HumanInboxDispatch>(
    () => ({
      refresh: () => post(refreshInboxAction()),
      open: (kind: HumanInboxKind, id: string) => post(openInboxItemAction(kind, id)),
      back: () => post(closeInboxItemAction()),
      resolveApproval: (id: string, decision: ApprovalDecision) => post(resolveInboxApprovalAction(id, decision)),
      closeValidation: (id: string, outcome: ValidationOutcome, note: string) =>
        post(closeInboxValidationAction(id, outcome, note)),
      assignValidation: (id: string, assignee: string, expect: { assignee: string | null; updatedAt: string }) =>
        post(assignInboxValidationAction(id, assignee, expect)),
      decideSavedAgentProposal: (id: string, digest: string, decision: "approve" | "deny", reason?: string) =>
        post(decideSavedAgentProposalAction(id, digest, decision, reason)),
      decideSavedAgentRemoval: (id: string, digest: string, decision: "approve" | "deny", reason?: string) =>
        post(decideSavedAgentRemovalAction(id, digest, decision, reason)),
      decideScheduleProposal: (id: string, decision: "approve" | "deny") =>
        post(decideScheduleProposalAction(id, decision)),
    }),
    [],
  );

  return showing === "item"
    ? <ItemApp vm={itemVm} missing={missing} dispatch={dispatch} error={error} />
    : <App vm={vm} error={error} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) {
  render(
    <ErrorBoundary>
      <HumanInboxRoot />
    </ErrorBoundary>,
    root,
  );
}
