import fs from "node:fs";
import path from "node:path";
import {
  APPROVALS_REL_DIR,
  APPROVAL_ID_PREFIX,
  witnessedDecisionSealState,
  readApprovalRequest,
  type ApprovalPayload,
  type ApprovalRequest,
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
 * t-d85857 — the ONE pending-approval read behind both Control surfaces: the Approvals section
 * (which renders these items) and Overview's counter (which only counts them). They used to have
 * different sources — the section read this, while the shell bundled a hardcoded empty list — so
 * Overview reported `approvals pending: 0` with requests sitting on disk. A security counter that
 * reads zero is worse than no counter, so the two now cannot disagree by construction.
 *
 * Pending is what a human still owes an answer to: resolved and cancelled records are skipped, and
 * a record whose payloadHash no longer matches, whose decision seal is broken (t-65e80b), or that
 * will not parse at all is still listed — tampering is a reason to look at it, never a reason to drop
 * it from the count.
 */
export function listPendingApprovalViewItems(workspaceRoot: string): ApprovalViewItem[] {
  const approvals: ApprovalViewItem[] = [];
  const dir = path.join(workspaceRoot, APPROVALS_REL_DIR);
  if (!fs.existsSync(dir)) return approvals;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(APPROVAL_ID_PREFIX) && f.endsWith(".json")).sort();
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    try {
      const request = readApprovalRequest(workspaceRoot, id);
      if (request.status !== "pending") continue;
      approvals.push({
        id: request.id,
        requester: request.requester,
        session: request.session,
        createdAt: request.createdAt,
        payload: request.payload,
        tampered: false,
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
          warning: `approval record '${id}' is unreadable`,
        });
      }
    }
  }
  return approvals;
}

/** Overview's row shape for the same pending set — id + status only; the counter renders no payload. */
export function pendingApprovalRows(workspaceRoot: string): CockpitApprovalRow[] {
  return listPendingApprovalViewItems(workspaceRoot).map((item) => ({ id: item.id, status: "pending" }));
}
