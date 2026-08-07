import fs from "node:fs";
import path from "node:path";
import {
  APPROVALS_REL_DIR,
  APPROVAL_ID_PREFIX,
  witnessedDecisionSealState,
  readApprovalRequest,
  type ApprovalCancellation,
  type ApprovalPayload,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
} from "../../bridge/approvalRequest.js";
import type { CockpitApprovalRow } from "../../cockpit/model.js";

export interface ApprovalViewItem {
  id: string;
  requester: string;
  session: string;
  createdAt: string;
  payload: ApprovalPayload;
  tampered: boolean;
  warning?: string;
  /** Production readers always set this; optional only for legacy preview/test fixtures. */
  status?: ApprovalStatus;
  resolution?: ApprovalResolution;
  cancellation?: ApprovalCancellation;
}

export interface ApprovalViewModel {
  folder: string;
  wsHash: string;
  approvals: ApprovalViewItem[];
}

const emptyPayload = (): ApprovalPayload => ({ reason: "", proposedAction: "", risk: "", exactPrompt: "" });

export function buildApprovalViewModel(input: { workspaceRoot: string; folder: string; wsHash: string }): ApprovalViewModel {
  return { folder: input.folder, wsHash: input.wsHash, approvals: listPendingApprovalViewItems(input.workspaceRoot) };
}

/**
 * The authoritative approval read behind both pending surfaces and the Human Inbox history. Pending
 * consumers use the wrapper below, so the Overview counter and action surface still cannot disagree;
 * history consumers retain the verified terminal records instead of copying them into another store.
 *
 * A record whose payloadHash no longer matches, whose decision seal is broken (t-65e80b), or that
 * will not parse at all stays pending: tampering cannot retire itself from the human's count.
 */
export function listApprovalViewItems(workspaceRoot: string): ApprovalViewItem[] {
  const approvals: ApprovalViewItem[] = [];
  const dir = path.join(workspaceRoot, APPROVALS_REL_DIR);
  if (!fs.existsSync(dir)) return approvals;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(APPROVAL_ID_PREFIX) && f.endsWith(".json")).sort();
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    try {
      const request = readApprovalRequest(workspaceRoot, id);
      approvals.push({
        id: request.id,
        requester: request.requester,
        session: request.session,
        createdAt: request.createdAt,
        payload: request.payload,
        tampered: false,
        status: request.status,
        ...(request.resolution ? { resolution: request.resolution } : {}),
        ...(request.cancellation ? { cancellation: request.cancellation } : {}),
      });
    } catch (err) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Partial<ApprovalViewItem> & { payload?: Partial<ApprovalPayload>; status?: string };
        // t-65e80b — a record whose DECISION seal is broken does not get to retire itself. `status` is
        // the field the seal covers, so trusting it here to skip the record would let the one edit this
        // read exists to catch also delete the evidence from the human's queue. A broken seal means the
        // decision bytes are not what was written, so what is on disk cannot say a human is done with
        // it — it stays listed, tampered, with the reader's message attached.
        const sealed = witnessedDecisionSealState(workspaceRoot, raw as ApprovalRequest) !== "broken";
        if (sealed && raw.status && raw.status !== "pending") continue;
        approvals.push({
          id: typeof raw.id === "string" ? raw.id : id,
          requester: typeof raw.requester === "string" ? raw.requester : "(unknown)",
          session: typeof raw.session === "string" ? raw.session : "(unknown)",
          createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
          payload: { ...emptyPayload(), ...(raw.payload ?? {}) },
          tampered: true,
          status: "pending",
          warning: err instanceof Error ? err.message : String(err),
        });
      } catch {
        approvals.push({
          id,
          requester: "(unreadable)",
          session: "(unreadable)",
          createdAt: "",
          payload: emptyPayload(),
          tampered: true,
          status: "pending",
          warning: `approval record '${id}' is unreadable`,
        });
      }
    }
  }
  return approvals;
}

/** The action surface remains pending-only; history consumers opt into the complete authoritative read. */
export function listPendingApprovalViewItems(workspaceRoot: string): ApprovalViewItem[] {
  return listApprovalViewItems(workspaceRoot).filter((item) => (item.status ?? "pending") === "pending");
}

/** Overview's row shape for the same pending set — id + status only; the counter renders no payload. */
export function pendingApprovalRows(workspaceRoot: string): CockpitApprovalRow[] {
  return listPendingApprovalViewItems(workspaceRoot).map((item) => ({ id: item.id, status: "pending" }));
}
