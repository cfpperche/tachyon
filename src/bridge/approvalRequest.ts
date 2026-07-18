import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * spec t-7d8bdf Phase 1 — the human-approval protocol BACKBONE. A child agent that needs real human
 * authorization (the case the runtime's auto-mode classifier guards — removing a safety guard, etc.)
 * escalates via the `request_human_approval` Bridge tool; the Bridge WITNESSES the escalation here, in
 * the SOURCE tree (tamper-resistant like `doorbell.ts` and canonical Delivery authority — a gated agent cannot
 * rewrite a file it never checks out), and surfaces it to the human through Control → Approvals + host
 * notification with the child's VERBATIM payload + provenance (checklist pins are not used for approvals).
 * Resolution is HOST-SIDE ONLY (never a Bridge tool — that would let a
 * coordinator resolve its own escalation, which is exactly the laundering the adversarial dueto killed).
 *
 * Load-bearing design invariants (preserved here, enforced at every seam):
 *   (1) requester identity is the Bridge-resolved caller, NEVER self-declared — `recordApprovalRequest`
 *       takes the resolved caller name as a positional argument; the Bridge tool never accepts an
 *       `agent`/`requester` param.
 *   (2) the human is shown the child's VERBATIM text, never a coordinator summary — Approvals UI
 *       renders the four child-authored fields verbatim + provenance only (`composeApprovalPinDetail`
 *       remains the shared text builder for that payload; optional legacy pinId on old records only).
 *   (3) resolution is host-side only, never agent-reachable — `resolveApproval` lives in this module
 *       (pure, with an `inject` callback) and is wired ONLY by the extension host's Phase 2 UI; there is
 *       no `resolve_approval` Bridge tool and `tools.ts` never imports the resolver.
 *   (4) the injected response is a FIXED Tachyon string, never free-form — `composeFixedApprovalResponse`
 *       is the single source of what gets typed back; the human's click picks approve/deny, nothing more.
 *
 * Threat model note (closes the adversarial re-review's CRITICAL finding, c3d74ac): the FIXED text from
 * (4) is, by construction, a deterministic function of two publicly-derivable values (the decision verb
 * and the request id), so it is NOT itself an unforgeable proof — any Bridge caller can reproduce it
 * byte-for-byte and type it into the requester's pane via the pre-existing, general-purpose `write_input`
 * tool while the requester is idle waiting on the human. The injected text is therefore only a WAKE-UP
 * nudge, never trust-bearing on its own. `readOwnApprovalRequest` below is the actual trust anchor: it is
 * exposed as the `get_approval_status` Bridge tool, scoped to `deps.caller` (the strong, per-agent-token-
 * authenticated identity — the same one `write_input`'s literal-terminal-injection channel cannot forge,
 * since forging it requires being the actual connected MCP client with that identity, not just typing
 * text into a pane) so the requester can confirm a resolution against the on-disk ground truth before
 * acting on anything an injected line claims.
 */

/** Directory under the workspace's `.tachyon/` that holds one JSON file per approval request. */
export const APPROVALS_REL_DIR = path.join(".tachyon", "approvals");

/** Append-only witness log — one JSON line per recorded request AND per resolution (doorbell parity). */
export const APPROVALS_WITNESS_REL_PATH = path.join(".tachyon", "approvals.jsonl");

/** Id shape mirrors pin `p-<6hex>` / validation `v-<6hex>` / task `t-<6hex>` — `a-` for approval. */
export const APPROVAL_ID_PREFIX = "a-";

export type ApprovalDecision = "approved" | "denied";

/** Lifecycle: pending → resolved (host Accept/Deny) | cancelled (requester withdraw). Never both. */
export type ApprovalStatus = "pending" | "resolved" | "cancelled";

/** The four child-authored fields, captured VERBATIM (after trim) — the human is shown these as-is. */
export interface ApprovalPayload {
  /** why the child is escalating — the human-readable reason for needing approval. */
  reason: string;
  /** the action the child proposes to take if approved. */
  proposedAction: string;
  /** the child's own characterization of the risk — shown verbatim, never re-summarized. */
  risk: string;
  /** the EXACT prompt/text the child asked to be answered/injected — shown verbatim. */
  exactPrompt: string;
}

/** The audit receipt appended to the witness log when a request is resolved. */
export interface ApprovalResolution {
  decision: ApprovalDecision;
  /** ISO timestamp of the human's resolve action. */
  resolvedAt: string;
  /** Best-effort identity of the VS Code user who clicked (filled by the host). */
  resolvedBy?: string;
  /** The FIXED Tachyon-generated text injected back into the child session (never free-form). */
  injectedText: string;
  /** Receipt from the host's `write_input(answering=true)` call into the child session. */
  writeInputReceipt?: string;
  /** Free-form note recorded by the host alongside the resolution (best-effort; never gated on). */
  note?: string;
}

/** t-ae89d1 — requester-authored withdrawal; never an Accept/Deny and never injects approve text. */
export interface ApprovalCancellation {
  /** ISO timestamp the Bridge witnessed the cancel. */
  cancelledAt: string;
  /** Always the Bridge-resolved requester (same as record.requester). */
  cancelledBy: string;
  /** Short audit reason the requester supplied. */
  reason: string;
}

export interface ApprovalRequest {
  /** `a-<6hex>` — see APPROVAL_ID_PREFIX. */
  id: string;
  /** Bridge-resolved caller name (kind "agent"). The child CANNOT self-declare this — the Bridge tool
   *  never accepts a requester param; this is `deps.caller.name`, populated at record time. */
  requester: string;
  /** Runtime kind of the requester's token (spec 351 — `agent`); recorded for audit. */
  requesterKind: "agent";
  /** The target tmux session the FIXED response must be injected into (resolved by the Bridge from the
   *  caller's own session — a child cannot request injection into someone else's pane). */
  session: string;
  /** Agent that owned `session` when the request was recorded. Used at host-side resolution time to refuse
   *  injecting a human decision into a pane that has since been reused by a different agent. */
  sessionOwnerAtRequest?: string;
  /** VERBATIM child-authored payload — shown to the human as-is, never a coordinator summary. */
  payload: ApprovalPayload;
  /** SHA-256 over the canonicalized child-authored fields — tamper-evident receipt. The host-side
   *  resolver re-validates this on load so a mutated file is rejected, never silently honored. */
  payloadHash: string;
  /** ISO timestamp the Bridge witnessed the request. */
  createdAt: string;
  /** `pending` until host resolve or requester cancel. Legacy records without cancel still use pending|resolved. */
  status: ApprovalStatus;
  /** Optional legacy pin id if an older build created a checklist pin; new requests omit this. */
  pinId?: string;
  /** Set when `status === "resolved"`. */
  resolution?: ApprovalResolution;
  /** Set when `status === "cancelled"` (t-ae89d1). Absent on pre-cancel records. */
  cancellation?: ApprovalCancellation;
}

/** Witness-log event — one JSON line per append. */
export type ApprovalWitnessEvent =
  | { kind: "requested"; id: string; requester: string; session: string; at: string; payloadHash: string }
  | { kind: "resolved"; id: string; decision: ApprovalDecision; at: string; by?: string }
  | { kind: "cancelled"; id: string; by: string; at: string; reason: string };

export function approvalRequestPath(workspaceRoot: string, id: string): string {
  return path.join(workspaceRoot, APPROVALS_REL_DIR, `${id}.json`);
}

/** New `a-<6hex>` id — uses crypto.randomBytes so two concurrent requests never collide. */
export function newApprovalRequestId(): string {
  return `${APPROVAL_ID_PREFIX}${crypto.randomBytes(3).toString("hex")}`;
}

/** Canonicalized JSON for hashing — stable key order, no ambient whitespace. */
function canonicalizePayload(payload: ApprovalPayload): string {
  return JSON.stringify({
    reason: payload.reason,
    proposedAction: payload.proposedAction,
    risk: payload.risk,
    exactPrompt: payload.exactPrompt,
  });
}

/** SHA-256 of the canonicalized child-authored fields — stored on the record and re-checked on resolve. */
export function computePayloadHash(payload: ApprovalPayload): string {
  return crypto.createHash("sha256").update(canonicalizePayload(payload)).digest("hex");
}

/** Re-validates the on-disk record's `payloadHash` against its stored payload — rejects tampering. */
export function payloadHashMatches(record: ApprovalRequest): boolean {
  return computePayloadHash(record.payload) === record.payloadHash;
}

function normalizeChildField(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new Error(`request_human_approval requires a non-empty ${field}`);
  return trimmed;
}

/** Pure builder — the Bridge tool and the tests both go through this so the record shape is one decision. */
export function buildApprovalRequest(input: {
  requester: string;
  session: string;
  reason: string;
  proposedAction: string;
  risk: string;
  exactPrompt: string;
  id?: string;
  createdAt?: string;
}): ApprovalRequest {
  const payload: ApprovalPayload = {
    reason: normalizeChildField(input.reason, "reason"),
    proposedAction: normalizeChildField(input.proposedAction, "proposed_action"),
    risk: normalizeChildField(input.risk, "risk"),
    exactPrompt: normalizeChildField(input.exactPrompt, "exact_prompt"),
  };
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id ?? newApprovalRequestId(),
    requester: input.requester,
    requesterKind: "agent",
    session: input.session,
    sessionOwnerAtRequest: input.requester,
    payload,
    payloadHash: computePayloadHash(payload),
    createdAt,
    status: "pending",
  };
}

/** Writes the request JSON under `.tachyon/approvals/<id>.json` and returns the absolute path. */
export function writeApprovalRequest(workspaceRoot: string, request: ApprovalRequest): string {
  const file = approvalRequestPath(workspaceRoot, request.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return file;
}

export function readApprovalRequest(workspaceRoot: string, id: string): ApprovalRequest {
  const file = approvalRequestPath(workspaceRoot, id);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ApprovalRequest;
  if (parsed.id !== id) throw new Error(`approval record id mismatch: expected '${id}' but file holds '${parsed.id}'`);
  if (!payloadHashMatches(parsed)) {
    throw new Error(`approval record '${id}' is corrupt — payloadHash no longer matches the child-authored payload`);
  }
  return parsed;
}

/**
 * Caller-scoped read — the AUTHENTICATED channel a requester uses to learn its own resolution, closing
 * the CRITICAL finding from review c3d74ac (a `write_input`-forged injected line is indistinguishable
 * from the real thing on its own; this function reads the on-disk ground truth instead). Throws if the
 * record doesn't exist/is tampered (same as `readApprovalRequest`) OR if it belongs to a different
 * requester — a caller can never use this to peek at another agent's request.
 */
export function readOwnApprovalRequest(workspaceRoot: string, id: string, requester: string): ApprovalRequest {
  const request = readApprovalRequest(workspaceRoot, id);
  if (request.requester !== requester) {
    throw new Error(`approval request '${id}' does not belong to '${requester}'`);
  }
  return request;
}

export function listApprovalRequests(workspaceRoot: string): ApprovalRequest[] {
  const dir = path.join(workspaceRoot, APPROVALS_REL_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${APPROVAL_ID_PREFIX}`) && f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as ApprovalRequest;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is ApprovalRequest => !!r);
}

export function listPendingApprovalRequests(workspaceRoot: string): ApprovalRequest[] {
  return listApprovalRequests(workspaceRoot).filter((r) => r.status === "pending");
}

/** Appends one JSON line to `.tachyon/approvals.jsonl` — the witness ledger (requested + resolved). */
export function appendApprovalWitnessEvent(workspaceRoot: string, event: ApprovalWitnessEvent): void {
  const file = path.join(workspaceRoot, APPROVALS_WITNESS_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

export function readApprovalWitnessEvents(workspaceRoot: string): ApprovalWitnessEvent[] {
  const file = path.join(workspaceRoot, APPROVALS_WITNESS_REL_PATH);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<ApprovalWitnessEvent>;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is ApprovalWitnessEvent => !!e && typeof (e as { kind?: string }).kind === "string");
}

/**
 * The FIXED Tachyon-generated response injected back into the child session on resolution. The human's
 * click picks `decision`; Tachyon composes the text — the child never sees free-form human input via
 * this path, so a hostile UI can't smuggle an arbitrary command into the pane. Tied to the request id so
 * a replayed/leaked injected line can be traced back to exactly the request it answered.
 *
 * Plain ASCII, single line — matches the envelope `notifyAgent.ts`'s sanitizer would produce, so it
 * survives the child pane's parser without any line-break/CRLF trickery.
 *
 * NOT unforgeable proof on its own (see threat-model note above) — a requester should treat this text as
 * a wake-up nudge and confirm via `get_approval_status`/`readOwnApprovalRequest` before acting on it.
 */
export function composeFixedApprovalResponse(request: ApprovalRequest, decision: ApprovalDecision): string {
  const verb = decision === "approved" ? "approved" : "denied";
  return `[tachyon] human ${verb} your approval request ${request.id} — you may proceed accordingly`;
}

/**
 * The VERBATIM PIN body shown to the human. This is the security-critical surface: the human clicks
 * knowing EXACTLY what the child asked and who the child is, with no coordinator re-summary in between.
 * Provenance (requester + session + createdAt + request id) sits ABOVE the verbatim payload so the human
 * cannot miss it; the four child-authored fields follow, each labeled and reproduced byte-for-byte.
 *
 * Returned as plain text because this Bridge payload is rendered outside the VS Code UI host.
 */
export function composeApprovalPinDetail(request: ApprovalRequest): string {
  const p = request.payload;
  return [
    `Human approval requested by agent '${request.requester}' (session ${request.session}).`,
    `Request id: ${request.id} — recorded at ${request.createdAt}.`,
    `Respond via the Tachyon approval view (Phase 2) — Approve or Deny only.`,
    ``,
    `--- child-authored payload (VERBATIM) ---`,
    `reason: ${p.reason}`,
    `proposed_action: ${p.proposedAction}`,
    `risk: ${p.risk}`,
    `exact_prompt: ${p.exactPrompt}`,
    `--- end verbatim payload ---`,
    ``,
    `Tachyon authenticated PROVENANCE, not correctness — read the pane before approving.`,
  ].join("\n");
}

/** Short sidebar title for the pin — kept under the 120-char pin-title cap. */
export function composeApprovalPinTitle(request: ApprovalRequest): string {
  const head = `Approval requested by '${request.requester}'`;
  const tail = `: ${request.payload.reason}`;
  const cap = 120;
  return head.length + tail.length <= cap ? `${head}${tail}` : `${head}${tail.slice(0, cap - head.length - 3).trimEnd()}...`;
}

/** Pin tags for `request_human_approval` pins — the host completes them on resolution. */
export function approvalPinTags(request: ApprovalRequest): string[] {
  return ["human-approval", `approval:${request.id}`];
}

/**
 * The host-side resolver — NEVER exposed as a Bridge tool (a coordinator resolving its own escalation IS
 * the laundering the adversarial dueto killed). The extension host's Phase 2 UI calls this with an
 * `inject` callback wired to the same `write_input(answering=true)` path the Bridge tool uses. Pure
 * otherwise — no `Bridge`/`AgentManager`/`tmux` imports here — so it stays table-testable.
 *
 * Re-validates the payloadHash on load (tamper-evident), refuses to resolve a non-pending request,
 * composes the FIXED injected text via `composeFixedApprovalResponse`, calls `inject`, then marks the
 * record resolved and appends a `resolved` witness event. An `inject` failure is RECORDED (so the human
 * can intervene) but does NOT flip the request back to pending — the human's decision stands.
 */
export async function resolveApproval(input: {
  workspaceRoot: string;
  id: string;
  decision: ApprovalDecision;
  resolvedBy?: string;
  now?: string;
  /** Host-side write_input(answering=true) — typed text is the FIXED Tachyon string, never caller-supplied. */
  inject: (session: string, text: string) => Promise<{ receipt?: string; error?: string }>;
  /** Host-side session ownership check. If the recorded session now belongs to someone else, refuse injection. */
  currentSessionOwner?: (session: string) => string | undefined | Promise<string | undefined>;
  /** Optional hook the host calls to complete the pin created at request time. */
  completePin?: (pinId: string, decision: ApprovalDecision) => void;
}): Promise<{ request: ApprovalRequest; injectedText: string; receipt?: string; injectError?: string }> {
  const request = readApprovalRequest(input.workspaceRoot, input.id);
  if (request.status === "resolved") {
    throw new Error(`approval request '${input.id}' is already resolved (${request.resolution?.decision})`);
  }
  if (request.status === "cancelled") {
    throw new Error(`approval request '${input.id}' was cancelled by the requester and cannot be resolved`);
  }
  const originalOwner = request.sessionOwnerAtRequest ?? request.requester;
  const currentOwner = await input.currentSessionOwner?.(request.session);
  if (currentOwner !== undefined && currentOwner !== originalOwner) {
    throw new Error(
      `approval request '${input.id}' refused: session '${request.session}' now belongs to '${currentOwner}', not original requester '${originalOwner}'`,
    );
  }
  const injectedText = composeFixedApprovalResponse(request, input.decision);
  const resolvedAt = input.now ?? new Date().toISOString();
  let receipt: string | undefined;
  let injectError: string | undefined;
  try {
    const r = await input.inject(request.session, injectedText);
    receipt = r.receipt;
    injectError = r.error;
  } catch (err) {
    injectError = err instanceof Error ? err.message : String(err);
  }
  const resolution: ApprovalResolution = {
    decision: input.decision,
    resolvedAt,
    ...(input.resolvedBy ? { resolvedBy: input.resolvedBy } : {}),
    injectedText,
    ...(receipt ? { writeInputReceipt: receipt } : {}),
    ...(injectError ? { note: `inject error: ${injectError}` } : {}),
  };
  const updated: ApprovalRequest = { ...request, status: "resolved", resolution };
  writeApprovalRequest(input.workspaceRoot, updated);
  appendApprovalWitnessEvent(input.workspaceRoot, {
    kind: "resolved",
    id: updated.id,
    decision: input.decision,
    at: resolvedAt,
    ...(input.resolvedBy ? { by: input.resolvedBy } : {}),
  });
  if (updated.pinId && input.completePin) {
    try {
      input.completePin(updated.pinId, input.decision);
    } catch {
      // best-effort — the request is already resolved; a pin-completion failure must not undo that.
    }
  }
  return { request: updated, injectedText, ...(receipt ? { receipt } : {}), ...(injectError ? { injectError } : {}) };
}

/**
 * t-ae89d1 — requester withdraws a still-pending approval. Only the Bridge-resolved requester may cancel;
 * never injects Approve text; never records Accept/Deny. Retry on an already-cancelled own request is
 * idempotent. Race with host resolve: the loser gets a structured conflict (already resolved/cancelled).
 */
export function cancelOwnApprovalRequest(input: {
  workspaceRoot: string;
  id: string;
  requester: string;
  reason: string;
  now?: string;
  /** Best-effort pin completion when the request carried pinId. */
  completePin?: (pinId: string) => void;
}): { request: ApprovalRequest; alreadyCancelled: boolean } {
  const reason = (input.reason ?? "").trim();
  if (reason.length === 0) throw new Error("cancel_human_approval requires a non-empty reason");
  if (reason.length > 2000) throw new Error("cancel_human_approval reason must be ≤ 2000 chars");

  const request = readOwnApprovalRequest(input.workspaceRoot, input.id, input.requester);
  if (request.status === "cancelled") {
    return { request, alreadyCancelled: true };
  }
  if (request.status === "resolved") {
    throw new Error(
      `approval request '${input.id}' is already resolved (${request.resolution?.decision}) — cannot cancel`,
    );
  }
  const cancelledAt = input.now ?? new Date().toISOString();
  const cancellation: ApprovalCancellation = {
    cancelledAt,
    cancelledBy: input.requester,
    reason,
  };
  const updated: ApprovalRequest = { ...request, status: "cancelled", cancellation };
  writeApprovalRequest(input.workspaceRoot, updated);
  appendApprovalWitnessEvent(input.workspaceRoot, {
    kind: "cancelled",
    id: updated.id,
    by: input.requester,
    at: cancelledAt,
    reason,
  });
  if (updated.pinId && input.completePin) {
    try {
      input.completePin(updated.pinId);
    } catch {
      // best-effort — cancel already stands
    }
  }
  return { request: updated, alreadyCancelled: false };
}
