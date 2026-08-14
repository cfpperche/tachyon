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
 * Resolution is HOST-SIDE BY DESIGN (never a Bridge tool — that would let a
 * coordinator resolve its own escalation, which is exactly the laundering the adversarial dueto killed).
 * That INTENT is worth keeping stated, and it is NOT what the product enforces today: three doors reach
 * resolution with no human gesture, each reproduced by a test. They are enumerated under invariant (3).
 *
 * Load-bearing design invariants (preserved here, enforced at every seam):
 *   (1) requester identity is the Bridge-resolved caller, NEVER self-declared — `recordApprovalRequest`
 *       takes the resolved caller name as a positional argument; the Bridge tool never accepts an
 *       `agent`/`requester` param.
 *   (2) the human is shown the child's VERBATIM text, never a coordinator summary — Approvals UI
 *       renders the four child-authored fields verbatim + provenance only (`composeApprovalPinDetail`
 *       remains the shared text builder for that payload; optional legacy pinId on old records only).
 *   (3) resolution is host-side only, never agent-reachable — the INTENT of this design, and MEASURED
 *       FALSE on 2026-08-05. What still holds: `resolveApproval` lives in this module (pure, with an
 *       `inject` callback), there is no `resolve_approval` Bridge tool, and `tools.ts` never imports the
 *       resolver. What does not hold: three doors reach resolution with no human gesture, each
 *       REPRODUCED by a test rather than argued from reading —
 *         door 1 (t-6edd70) — a same-uid control-socket speaker invokes the named action
 *           `approval.resolve`; the nonce alone carries it and no caller identity is consulted anywhere
 *           on the path (`test/unit/approvalResolveSocketReachability.test.ts`).
 *         door 2 (t-de7df4) — the same speaker mints its OWN Companion pair code over that socket, pairs
 *           over loopback, and resolves with the device token it just minted
 *           (`test/unit/companionPairApprovalReachability.test.ts`).
 *         door 3 (t-65e80b) — `status` and `resolution` are edited straight into the record's JSON, with
 *           no resolver involved at all (`test/unit/namedActionHumanGateReachability.test.ts`). STILL
 *           OPEN — the write is a plain file write and nothing stops it — but no longer SILENT: the
 *           decision now carries its own seal (`decisionSeal` below), so `readApprovalRequest` refuses a
 *           record whose decision bytes changed after they were written. Detecting is not preventing,
 *           and the seal proves bytes, never an actor; read the seal block before extending that claim.
 *       CLOSING these doors is a capability fix (uid/sandbox isolation) and is deliberately NOT done
 *       here — it stays open as t-5313dc. t-86e59a did the honest half only: since the host cannot know
 *       WHO resolved, it stopped claiming to. `resolvedBy` now names the CHANNEL the resolution arrived
 *       through (`APPROVAL_RESOLUTION_CHANNELS` in the Bridge adapter), so the audit trail no longer credits an actor
 *       nobody proved. A fourth door would inherit the same rule: name the channel, claim no actor.
 *   (4) the injected response is a FIXED Tachyon string, never free-form — `composeFixedApprovalResponse`
 *       is the single source of what gets typed back; the resolving call picks approve/deny, nothing more.
 *
 * Threat model note (closes the adversarial re-review's CRITICAL finding, c3d74ac): the FIXED text from
 * (4) is, by construction, a deterministic function of three publicly-derivable values (the decision, the
 * request id, and the channel — a closed set of constants), so it is NOT itself an unforgeable proof — any Bridge caller can reproduce it
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

/**
 * t-86e59a — what `resolvedBy` is allowed to say.
 *
 * It used to say `"vscode"` or `"companion"`: server-side constants asserting an ACTOR the server has
 * no way to observe. Three doors (invariant (3) above) resolve an approval with no human gesture, and
 * every one of them wrote a name a human auditor would read as themselves. That made the record worse
 * than empty, because it looked informative.
 *
 * A channel is the one thing the host actually knows: which entry point the resolution arrived through.
 * The `unattributed:` prefix is load-bearing and not decoration — it is what stops the value from being
 * read as an actor at a glance, given that the FIELD is still called `resolvedBy`. It also keeps the old
 * records legible as exactly what they are: written before we knew.
 *
 * Deliberately NOT derived from the caller. The control socket has no trustworthy identity (self-asserted
 * hello, shared nonce — t-93ac7f), so deriving provenance from a declaration would swap a false trail for
 * one that LOOKS proven, which is worse than today. A channel constant claims only what its own call site
 * guarantees: that the resolution came through this door.
 */
/** Domain vocabulary implemented by the Bridge channel constants. */
export type ApprovalResolutionChannel = "unattributed:vscode-command" | "unattributed:companion-http";

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
  /**
   * The CHANNEL the resolution arrived through — never an actor (t-86e59a). One of
   * `APPROVAL_RESOLUTION_CHANNELS`. This used to read "best-effort identity of the VS Code user who
   * clicked", which the host cannot observe on any of its three doors. Records written before that was
   * measured still hold the old `"vscode"` / `"companion"`; they are history and are never rewritten.
   */
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
  /** SHA-256 over the canonicalized child-authored fields — the CREATION receipt. Covers the payload
   *  and nothing else: it is computed once here, copied into the `requested` witness line, and carried
   *  unchanged across every later write, which is what keeps that ledger line checkable. The DECISION
   *  is sealed separately by `decisionSeal` (t-65e80b) — this field never covered it. */
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
  /** t-65e80b — seal format of `decisionSeal`. Absent on records written before the seal existed. */
  decisionSealVersion?: number;
  /** t-65e80b — SHA-256 over the DECISION fields (`status` + `resolution` + `cancellation`), bound to
   *  the record's creation identity, recomputed at every write. See the seal block below for what it
   *  proves and — at least as important — what it does not. */
  decisionSeal?: string;
}

/** Witness-log event — one JSON line per append. */
export type ApprovalWitnessEvent =
  | {
      kind: "requested";
      id: string;
      requester: string;
      session: string;
      at: string;
      payloadHash: string;
      /** Absent on historical lines written before t-f85a02. */
      decisionSealVersion?: number;
    }
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

/**
 * t-65e80b — the DECISION seal.
 *
 * MEASURED FIRST, because the answer decides the shape of the fix. `payloadHash` covers only the four
 * child-authored fields BY DESIGN, not by oversight: it is a CREATION receipt. It is computed once in
 * `buildApprovalRequest`, copied verbatim into the `requested` line of the witness ledger, and carried
 * unchanged through every later write — which is exactly what keeps that ledger line checkable against
 * the record afterwards. Widening `canonicalizePayload` to swallow `status`/`resolution` would break
 * both halves: every legitimate resolution would invalidate the stored hash unless it were recomputed,
 * and a recomputed hash is no longer a receipt of anything that happened at creation.
 *
 * So the decision needs its OWN seal, written at the moment the decision is written. Two seals, two
 * questions: `payloadHash` answers "is this still what the child asked?", `decisionSeal` answers "is
 * this still the decision that was recorded?".
 *
 * WHAT THIS PROVES, exactly: the decision bytes on disk are the ones a writer produced through
 * `writeApprovalRequest`, and nothing has edited them since.
 *
 * WHAT IT DOES NOT PROVE — and must never be written as if it did; t-86e59a removed one such claim
 * from this file already:
 *   - not WHO wrote them. The seal is unkeyed and this module is readable by the same uid that writes
 *     the file, so anyone able to run this code can produce a valid seal over any decision they like.
 *     DETECTING an edit is not PREVENTING a resolution; closing the door is a capability fix and stays
 *     t-5313dc. Door 3 in invariant (3) above is still open — it is now noisy, not shut.
 *   - not that a human decided. No path to this record observes a person.
 *   - not WHO wrote the witness ledger either. For post-t-f85a02 records, the requested line in that
 *     second file says this record was born in the seal era; it does not identify either writer.
 *   - not that an unsealed record with a historical requested line was tampered with. A requested line
 *     carrying no `decisionSealVersion` predates t-f85a02 and is read exactly as it always was —
 *     accusing it would be accusing legitimate history.
 *
 * t-f85a02 closes the one-file DOWNGRADE limit by binding the era to the requested witness line: a
 * rewrite that drops BOTH record fields now contradicts the second file. This is one additional edit,
 * not a closed door. A same-uid forger who also deletes/changes the ledger marker can still make the
 * rewrite look historical, because neither file is keyed or access-isolated (t-5313dc remains open).
 */
export const DECISION_SEAL_VERSION = 1;

/**
 * `unsealed` — no seal fields at all: written before this change. Read as-is, never accused.
 * `intact`   — the seal matches the decision bytes it covers.
 * `broken`   — seal missing on a sealed-era record, mismatched, or of a version this build cannot
 *              check. An unrecognized version counts as broken on purpose: reading it as "legacy"
 *              would hand a forger a one-field bypass around the whole seal.
 */
export type DecisionSealState = "unsealed" | "intact" | "broken";

/** Canonicalized JSON for the decision seal — stable key order, `null` for every absent optional. */
function canonicalizeDecision(record: ApprovalRequest): string {
  const r = record.resolution;
  const c = record.cancellation;
  return JSON.stringify({
    v: DECISION_SEAL_VERSION,
    // Bound to the record's creation identity so a valid seal cannot be lifted off one record and
    // pasted onto another: id + createdAt + requester + payloadHash pin it to this request.
    id: record.id,
    createdAt: record.createdAt,
    requester: record.requester,
    payloadHash: record.payloadHash,
    status: record.status,
    resolution: r
      ? {
          decision: r.decision,
          resolvedAt: r.resolvedAt,
          resolvedBy: r.resolvedBy ?? null,
          injectedText: r.injectedText,
          writeInputReceipt: r.writeInputReceipt ?? null,
          note: r.note ?? null,
        }
      : null,
    cancellation: c ? { cancelledAt: c.cancelledAt, cancelledBy: c.cancelledBy, reason: c.reason } : null,
  });
}

/** SHA-256 of the canonicalized decision fields — recomputed at every write, checked on every read. */
export function computeDecisionSeal(record: ApprovalRequest): string {
  return crypto.createHash("sha256").update(canonicalizeDecision(record)).digest("hex");
}

/** Stamps the seal era and seals the record's CURRENT decision. Idempotent — the seal is not self-covering. */
export function sealDecision(record: ApprovalRequest): ApprovalRequest {
  const stamped: ApprovalRequest = { ...record, decisionSealVersion: DECISION_SEAL_VERSION };
  return { ...stamped, decisionSeal: computeDecisionSeal(stamped) };
}

/** Pure predicate; workspace-aware readers pass the externally witnessed seal version. */
export function decisionSealState(
  record: ApprovalRequest,
  witnessedSealVersion?: number,
): DecisionSealState {
  const { decisionSealVersion: version, decisionSeal: seal } = record;
  // t-f85a02 — the witness lives in a second file, so removing both fields from THIS file no longer
  // turns a post-seal request into history. Invalid/conflicting witness versions arrive as NaN and are
  // broken too: an unreadable era marker must not become another downgrade spelling.
  if (witnessedSealVersion !== undefined) {
    if (!Number.isInteger(witnessedSealVersion) || witnessedSealVersion < 1 || version !== witnessedSealVersion) {
      return "broken";
    }
  }
  if (version === undefined && seal === undefined) return "unsealed";
  if (version !== DECISION_SEAL_VERSION || typeof seal !== "string") return "broken";
  return seal === computeDecisionSeal(record) ? "intact" : "broken";
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
  // Sealed here too, not only at the write door, so the in-memory record the Bridge tool answers with
  // is byte-identical to what lands on disk. `sealDecision` is idempotent, so the write reseal is a
  // no-op over this one.
  return sealDecision({
    id: input.id ?? newApprovalRequestId(),
    requester: input.requester,
    requesterKind: "agent",
    session: input.session,
    sessionOwnerAtRequest: input.requester,
    payload,
    payloadHash: computePayloadHash(payload),
    createdAt,
    status: "pending",
  });
}

/**
 * Writes the request JSON under `.tachyon/approvals/<id>.json` and returns the absolute path.
 *
 * The seal is (re)computed HERE because this is the single write door every decision goes through —
 * `resolveApproval`, `cancelOwnApprovalRequest` and the request tool all land in this function. Sealing
 * at each of those call sites instead would mean a future fourth writer silently produces an unsealed
 * (or stale-sealed) record; sealing here makes that impossible by construction rather than by comment.
 * "Who else can reach this?" is the habit `docs/project-guidance.md` names, applied to the seal itself.
 *
 * The seal covers the bytes THIS call writes, which is the only thing it is allowed to claim. It says
 * nothing about who called — see the seal block above.
 */
export function writeApprovalRequest(workspaceRoot: string, request: ApprovalRequest): string {
  const file = approvalRequestPath(workspaceRoot, request.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(sealDecision(request), null, 2)}\n`, "utf8");
  return file;
}

/**
 * Creates a NEW approval record and its seal-era witness.
 *
 * The ledger append deliberately happens first. The old record-then-ledger order left a crash window
 * in which a post-seal record existed with no second-file evidence of its era; stripping its two seal
 * fields would then look historical again. A crash after this append can leave an orphan witness but
 * no approval record, which is fail-closed: there is no decision for a reader to honour.
 */
export function recordApprovalRequest(workspaceRoot: string, request: ApprovalRequest): string {
  const file = approvalRequestPath(workspaceRoot, request.id);
  if (fs.existsSync(file)) throw new Error(`approval request '${request.id}' already exists`);
  const sealed = sealDecision(request);
  appendApprovalWitnessEvent(workspaceRoot, {
    kind: "requested",
    id: sealed.id,
    requester: sealed.requester,
    session: sealed.session,
    at: sealed.createdAt,
    payloadHash: sealed.payloadHash,
    decisionSealVersion: sealed.decisionSealVersion,
  });
  return writeApprovalRequest(workspaceRoot, sealed);
}

/** The seal era witnessed for this id, or undefined for genuine pre-t-f85a02 history. */
function witnessedDecisionSealVersion(workspaceRoot: string, id: string): number | undefined {
  const requested = readApprovalWitnessEvents(workspaceRoot).filter(
    (event): event is Extract<ApprovalWitnessEvent, { kind: "requested" }> =>
      event.kind === "requested" && event.id === id,
  );
  const versions = requested
    .filter((event) => Object.prototype.hasOwnProperty.call(event, "decisionSealVersion"))
    .map((event) => event.decisionSealVersion);
  if (versions.length === 0) return undefined;
  if (versions.some((version) => typeof version !== "number")) return Number.NaN;
  const distinct = new Set(versions as number[]);
  return distinct.size === 1 ? (versions[0] as number) : Number.NaN;
}

/** Workspace-aware state used by both the trust-bearing reader and the human pending surface. */
export function witnessedDecisionSealState(workspaceRoot: string, record: ApprovalRequest): DecisionSealState {
  return decisionSealState(record, witnessedDecisionSealVersion(workspaceRoot, record.id));
}

export function readApprovalRequest(workspaceRoot: string, id: string): ApprovalRequest {
  const file = approvalRequestPath(workspaceRoot, id);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ApprovalRequest;
  if (parsed.id !== id) throw new Error(`approval record id mismatch: expected '${id}' but file holds '${parsed.id}'`);
  if (!payloadHashMatches(parsed)) {
    throw new Error(`approval record '${id}' is corrupt — payloadHash no longer matches the child-authored payload`);
  }
  // t-65e80b — REFUSE rather than MARK, and the reason is what this reader IS. Everything downstream of
  // an approval reads the decision through here (`get_approval_status` via `readOwnApprovalRequest`, the
  // resolver, Control's approval view). A mark would have to be looked at by every one of those callers
  // to mean anything, and the caller that matters most is an agent deciding whether it may proceed — it
  // reads `status`/`resolution` and acts. A record that answers "resolved/approved" while carrying a
  // "possibly forged" flag is honoured by default, which is the defect wearing a label.
  //
  // Refusal is governed, not destructive, and that is what makes it affordable here: the bytes stay on
  // disk untouched, and the surfaces a human uses to LOOK do not go through this throw — Control's
  // pending list catches this throw and shows the record as tampered, carrying the message with it
  // (t-d85857 built that path for `payloadHash`), so a broken record becomes MORE visible, not less.
  // What a refusal costs is the requester's own read of a broken record; a new request is the recovery,
  // and it needs no privileged repair door (the family t-0cbcbd's rule).
  if (witnessedDecisionSealState(workspaceRoot, parsed) === "broken") {
    throw new Error(
      `approval record '${id}' is corrupt — its decision (status/resolution) no longer matches the decision seal ` +
        `written with it. This proves the bytes changed after they were sealed; it does not say who changed them.`,
    );
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
 * The FIXED Tachyon-generated response injected back into the child session on resolution. The resolving
 * call picks `decision`; Tachyon composes the text — the child never sees free-form input via this path,
 * so a hostile UI can't smuggle an arbitrary command into the pane. Tied to the request id so a
 * replayed/leaked injected line can be traced back to exactly the request it answered.
 *
 * t-86e59a — this line used to open `[tachyon] human approved your approval request ...`, and that word
 * was the worst instance of the defect this task fixed, for a reason that only showed up when the scope
 * was measured: `resolvedBy` has NO reader in src/, so the audit field nobody reads was the cosmetic
 * half. THIS line is the operative one. It is what the requesting agent CONSUMES to decide whether to
 * proceed, which makes `human` not an audit trace but a SIGNAL — a machine-read claim that a person
 * acted, on three doors where no person needs to. It now states the decision (that part is true and the
 * agent needs it), names the channel, and says outright that the claim cannot be made.
 *
 * The closing sentence names the LIMIT of the check instead of offering a remedy, and that is
 * deliberate. `get_approval_status` re-reads the same record, so on "who decided" it is a mirror and
 * adds nothing. What it does add is a different question: this line is text in a pane, and any Bridge
 * caller can type those bytes into an idle requester via `write_input` without resolving anything
 * (c3d74ac). The tool reads the on-disk record over a per-agent-authenticated channel that pane-typing
 * cannot forge, so it separates "a resolution was really recorded" from "text appeared in my terminal".
 * Promising more than that would be the disease this task treats, in the shape of advice.
 *
 * Single line, no line breaks — matches the envelope `notifyAgent.ts`'s sanitizer would produce, so it
 * survives the child pane's parser without any line-break/CRLF trickery. (The em dash is not ASCII; the
 * old note here claimed "plain ASCII" while the line already carried one.)
 *
 * NOT unforgeable proof on its own (see threat-model note above): every input is publicly derivable, the
 * channel included — it is a closed set of constants, not caller-supplied text, so invariant (4) holds.
 */
export function composeFixedApprovalResponse(
  request: ApprovalRequest,
  decision: ApprovalDecision,
  channel?: ApprovalResolutionChannel,
): string {
  const state = decision === "approved" ? "APPROVED" : "DENIED";
  // An omitted channel is stated, never silently dropped: silence would read as "no doubt here".
  const via = channel ? `recorded via channel ${channel}` : "recorded with no channel declared";
  return (
    `[tachyon] approval request ${request.id} is ${state} — ${via}. ` +
    `Tachyon cannot prove a human made this decision: the channel is all it observed. ` +
    `get_approval_status(${request.id}) proves only that this line is not a forgery typed into your pane; ` +
    `it reads the same record and cannot tell you who decided.`
  );
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
 * Re-validates the payloadHash AND the decision seal on load (tamper-evident), refuses to resolve a
 * non-pending request, composes the FIXED injected text via `composeFixedApprovalResponse`, calls
 * `inject`, then marks the record resolved and appends a `resolved` witness event. An `inject` failure is RECORDED (so the human
 * can intervene) but does NOT flip the request back to pending — the human's decision stands.
 */
export async function resolveApproval(input: {
  workspaceRoot: string;
  id: string;
  decision: ApprovalDecision;
  /** The CHANNEL this resolution arrived through — an `APPROVAL_RESOLUTION_CHANNELS` member, never an
   *  actor name and never anything derived from the caller (t-86e59a). Recorded verbatim in BOTH durable
   *  places below: the request record and the witness ledger. */
  resolvedBy?: ApprovalResolutionChannel;
  now?: string;
  /** Host-side write_input(answering=true) — typed text is the FIXED Tachyon string, never caller-supplied. */
  inject: (session: string, text: string) => Promise<{ receipt?: string; error?: string }>;
  /** Host-side session ownership check. If the recorded session now belongs to someone else, refuse injection. */
  currentSessionOwner?: (session: string) => string | undefined | Promise<string | undefined>;
  /** Optional hook the host calls to complete the pin created at request time. */
  completePin?: (pinId: string, decision: ApprovalDecision) => void | Promise<void>;
}): Promise<{
  request: ApprovalRequest;
  injectedText: string;
  receipt?: string;
  injectError?: string;
  /** t-7a306a — the pin could not be completed. The approval still resolved; this must not vanish. */
  pinError?: string;
}> {
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
  const injectedText = composeFixedApprovalResponse(request, input.decision, input.resolvedBy);
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
  // Sealed before the write so the record this function RETURNS is the record on disk (the write door
  // seals too, and the seal is idempotent — this is about the returned value, not about the file).
  const updated: ApprovalRequest = sealDecision({ ...request, status: "resolved", resolution });
  writeApprovalRequest(input.workspaceRoot, updated);
  appendApprovalWitnessEvent(input.workspaceRoot, {
    kind: "resolved",
    id: updated.id,
    decision: input.decision,
    at: resolvedAt,
    ...(input.resolvedBy ? { by: input.resolvedBy } : {}),
  });
  let pinError: string | undefined;
  if (updated.pinId && input.completePin) {
    try {
      await input.completePin(updated.pinId, input.decision);
    } catch (err) {
      // t-7a306a — best-effort, and no longer silent.
      //
      // The decision is already recorded, so failing here would tell a human their approval did not
      // go through and invite them to retry something already done. Swallowing it whole was the other
      // half of the same mistake: the pin they were looking at stays open and nothing says why. This
      // is the shape `injectError` above already uses — the operation succeeded, and its secondary
      // failure travels with the result instead of disappearing.
      //
      // It cannot join the resolution `note`: that record was written before this ran, and rewriting
      // it to append a later failure would make the durable record disagree with what was persisted
      // at decision time.
      pinError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    request: updated,
    injectedText,
    ...(receipt ? { receipt } : {}),
    ...(injectError ? { injectError } : {}),
    ...(pinError ? { pinError } : {}),
  };
}

/**
 * t-ae89d1 — requester withdraws a still-pending approval. Only the Bridge-resolved requester may cancel;
 * never injects Approve text; never records Accept/Deny. Retry on an already-cancelled own request is
 * idempotent. Race with host resolve: the loser gets a structured conflict (already resolved/cancelled).
 */
export async function cancelOwnApprovalRequest(input: {
  workspaceRoot: string;
  id: string;
  requester: string;
  reason: string;
  now?: string;
  /** Best-effort pin completion when the request carried pinId. */
  completePin?: (pinId: string) => void | Promise<void>;
}): Promise<{ request: ApprovalRequest; alreadyCancelled: boolean }> {
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
  const updated: ApprovalRequest = sealDecision({ ...request, status: "cancelled", cancellation });
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
      await input.completePin(updated.pinId);
    } catch {
      // best-effort — cancel already stands
    }
  }
  return { request: updated, alreadyCancelled: false };
}
