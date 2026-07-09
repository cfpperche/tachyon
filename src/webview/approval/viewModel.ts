import fs from "node:fs";
import path from "node:path";
import { APPROVALS_REL_DIR, APPROVAL_ID_PREFIX, readApprovalRequest, type ApprovalPayload } from "../../bridge/approvalRequest.js";

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
  const approvals: ApprovalViewItem[] = [];
  const dir = path.join(input.workspaceRoot, APPROVALS_REL_DIR);
  if (!fs.existsSync(dir)) return { folder: input.folder, wsHash: input.wsHash, approvals };
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(APPROVAL_ID_PREFIX) && f.endsWith(".json")).sort();
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    try {
      const request = readApprovalRequest(input.workspaceRoot, id);
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
        if (raw.status && raw.status !== "pending") continue;
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
  return { folder: input.folder, wsHash: input.wsHash, approvals };
}
