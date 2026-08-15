import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  admitSavedAgentProposal,
  computeSavedAgentProposalDigest,
  savedAgentProposalIsExpired,
  type SavedAgentProposal,
  type SavedAgentProposalAdmission,
} from "./savedAgentProposal.js";
import type { SavedAgentProposalDecisionRecord } from "./savedAgentProposalDecision.js";
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";
import type { AgentOwnershipRosterV1 } from "@tachyon/shared/config/agentProfileStudio.js";

/**
 * SDD 482 phase 4 slice B (`t-5e1113`) — where a proposal LIVES, and what a restart does to it.
 *
 * Ratified decision 4: a pending proposal lives 24h, survives a restart, collapses an identical
 * digest, and is invalidated when its base state diverges. Slice A made those pure decisions; this
 * makes them durable, which is where each of them can actually fail.
 *
 * ## The door reaches this file
 *
 * `propose_saved_agent` writes here, so every guard below is on an agent-reachable path. Nothing here
 * creates a profile, an authority record or a roster entry, and there is still no approval or commit
 * path — but "unreachable" stopped being true the moment the Bridge tool landed, and a comment that
 * said otherwise would be the most dangerous kind of stale.
 *
 * ## Why the digest is re-checked on every read
 *
 * A proposal is a file under `.tachyon/`. Anything that can write there can edit it, and the
 * dangerous edit is not deleting a proposal — it is CHANGING one that a human already looked at. So
 * the stored digest is recomputed from the stored fields on load and a mismatch is a hard refusal,
 * never a warning and never a silent repair. An approval is bound to a digest precisely so this check
 * has something to be bound to.
 */
export const SAVED_AGENT_PROPOSALS_REL_DIR = path.join(".tachyon", "agent-proposals");
export const SAVED_AGENT_RECEIPTS_REL_DIR = path.join(SAVED_AGENT_PROPOSALS_REL_DIR, "receipts");
export const SAVED_AGENT_PROPOSAL_WITNESS_REL_PATH = path.join(".tachyon", "agent-proposals.jsonl");
export const SAVED_AGENT_PROPOSAL_ID_PREFIX = "sp-";

export type SavedAgentProposalWitnessEvent =
  | { kind: "proposed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "collapsed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "cancelled"; id: string; by: string; reason: string; at: string; agentName?: string }
  | { kind: "denied"; id: string; digest: string; proposer: string; deniedBy: string; reason: string; agentName: string; at: string }
  | { kind: "expired"; id: string; digest: string; proposer: string; agentName: string; at: string }
  | { kind: "refused"; proposer: string; code: string; at: string }
  /** Untrusted files seen in the queue. Recorded so corruption is diagnosable rather than merely felt. */
  | { kind: "unreadable"; ids: string[]; at: string }
  /** A human approved this exact digest and the canonical transaction created the agent. */
  | { kind: "committed"; id: string; digest: string; approvedBy: string; at: string };

export function newSavedAgentProposalId(): string {
  return `${SAVED_AGENT_PROPOSAL_ID_PREFIX}${crypto.randomBytes(3).toString("hex")}`;
}

export function savedAgentProposalPath(workspaceRoot: string, id: string): string {
  return path.join(workspaceRoot, SAVED_AGENT_PROPOSALS_REL_DIR, `${id}.json`);
}

/** `sp-` + hex only. A traversal-shaped id must never become a path segment. */
const ID_RE = /^sp-[0-9a-f]{6}$/;

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid saved agent proposal id: ${JSON.stringify(id)}`);
}

/** Atomic publish: a reader never sees a partially written proposal. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* the rename failure is the real error */ }
    throw error;
  }
}

export function appendSavedAgentProposalWitness(workspaceRoot: string, event: SavedAgentProposalWitnessEvent): void {
  const file = path.join(workspaceRoot, SAVED_AGENT_PROPOSAL_WITNESS_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readSavedAgentProposalWitness(workspaceRoot: string): SavedAgentProposalWitnessEvent[] {
  const file = path.join(workspaceRoot, SAVED_AGENT_PROPOSAL_WITNESS_REL_PATH);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line) as SavedAgentProposalWitnessEvent; } catch { return undefined; } })
    .filter((event): event is SavedAgentProposalWitnessEvent => !!event && typeof event.kind === "string");
}

export class SavedAgentProposalTamperError extends Error {
  readonly code = "saved_agent_proposal_tampered";
}

/**
 * A proposal file that exists but cannot be trusted. Kept as DATA rather than swallowed, because the
 * two consequences of hiding it are both real: a human cannot tell "withdrawn" from "someone edited
 * this", and a proposal invisible to dedupe comes back with a fresh id instead of collapsing.
 */
export interface UnreadableSavedAgentProposal {
  id: string;
  reason: string;
}

export interface SavedAgentProposalListing {
  proposals: SavedAgentProposal[];
  /** Files present in the queue that could not be read or did not match their digest. */
  unreadable: UnreadableSavedAgentProposal[];
}

/**
 * Refuses to follow a symlink into or out of the proposal store.
 *
 * The store's whole posture is that a file under `.tachyon/` is only as trustworthy as its digest, and
 * a symlink is the one shape where the path itself lies before any digest is computed. Writing is
 * already safe by construction — temp + `rename` REPLACES a link rather than writing through it — so
 * this closes the reading half, and closes it at the same layer as the id validation rather than in
 * each caller.
 */
function assertNotSymlink(target: string, what: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return; // absent is not a symlink; the caller's own ENOENT handling applies
  }
  if (stat.isSymbolicLink()) {
    throw new SavedAgentProposalTamperError(`${what} is a symlink — refusing to read a Saved Agent proposal through one`);
  }
}

/**
 * Loads one proposal and re-derives its digest. A record whose digest does not match its own fields is
 * REFUSED, not repaired: recomputing the digest would launder exactly the edit this check exists to
 * catch, and an approval already bound to the old digest would then apply to different content.
 */
export function readSavedAgentProposal(workspaceRoot: string, id: string): SavedAgentProposal {
  assertId(id);
  const dir = path.join(workspaceRoot, SAVED_AGENT_PROPOSALS_REL_DIR);
  assertNotSymlink(dir, "the Saved Agent proposal directory");
  const file = savedAgentProposalPath(workspaceRoot, id);
  assertNotSymlink(file, `proposal '${id}'`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as SavedAgentProposal;
  const expected = computeSavedAgentProposalDigest({
    proposer: record.proposer,
    spec: record.spec,
    base: record.base,
  });
  if (record.digest !== expected) {
    throw new SavedAgentProposalTamperError(
      `saved agent proposal '${id}' does not match its digest — refusing to honour an edited proposal`,
    );
  }
  if (record.id !== id) {
    throw new SavedAgentProposalTamperError(`saved agent proposal '${id}' carries a different id inside`);
  }
  return record;
}

/** Every proposal on disk that parses and matches its digest. See `readSavedAgentProposalQueue`. */
export function listSavedAgentProposals(workspaceRoot: string): SavedAgentProposal[] {
  return readSavedAgentProposalQueue(workspaceRoot).proposals;
}

/**
 * The whole queue: what parses, and what does NOT.
 *
 * Corrupt entries used to be swallowed by an empty catch. That was wrong in two ways the reviewer
 * named. First, the digest mismatch is documented as "a hard refusal, never a warning" — but at the
 * LIST level a silent drop turns it into exactly a warning-free discard, and a human cannot tell
 * "withdrawn or expired" from "someone edited this". Second, dedupe runs over the live list, so an
 * unreadable proposal is invisible to collapse and the same request returns with a NEW id instead of
 * collapsing onto the old one — queue pressure on the human's attention, which is the volume gap the
 * threat model already worried about.
 *
 * So they are returned, not hidden. Read-by-id still throws; listing still never throws, because one
 * bad file must not blind the human to the rest of the queue.
 */
export function readSavedAgentProposalQueue(workspaceRoot: string): SavedAgentProposalListing {
  const dir = path.join(workspaceRoot, SAVED_AGENT_PROPOSALS_REL_DIR);
  if (!fs.existsSync(dir)) return { proposals: [], unreadable: [] };
  const proposals: SavedAgentProposal[] = [];
  const unreadable: UnreadableSavedAgentProposal[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    // The directory itself being unreadable (a symlink swapped in, a permission change) is a fact the
    // caller must see rather than an empty queue, which would read as "nothing pending".
    return { proposals: [], unreadable: [{ id: "(directory)", reason: error instanceof Error ? error.message : String(error) }] };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) {
      unreadable.push({ id: entry, reason: "file name is not a valid proposal id" });
      continue;
    }
    try {
      proposals.push(readSavedAgentProposal(workspaceRoot, id));
    } catch (error) {
      unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  unreadable.sort((a, b) => a.id.localeCompare(b.id));
  return { proposals, unreadable };
}

/** Live = on disk and not past its expiry. Expiry is evaluated at READ time, so a restart cannot revive one. */
export function listLiveSavedAgentProposals(workspaceRoot: string, nowMs: number): SavedAgentProposal[] {
  return listSavedAgentProposals(workspaceRoot).filter((p) => !savedAgentProposalIsExpired(p, nowMs));
}

/** Live proposals plus the untrusted files, which the ceiling still has to account for. */
export function readLiveSavedAgentProposalQueue(workspaceRoot: string, nowMs: number): SavedAgentProposalListing {
  const queue = readSavedAgentProposalQueue(workspaceRoot);
  return { proposals: queue.proposals.filter((p) => !savedAgentProposalIsExpired(p, nowMs)), unreadable: queue.unreadable };
}

/**
 * The one durable entry point. Admission (slice A) decides; this records the outcome.
 *
 * A collapsed re-proposal writes NOTHING new — same id, same file, same digest — so a retry loop
 * cannot grow the queue, and the witness log still records that the retry happened, because "nothing
 * changed" and "nothing was attempted" must stay distinguishable in an audit.
 */
export function recordSavedAgentProposal(input: {
  workspaceRoot: string;
  proposer: string;
  proposerProfile: Pick<AgentProfileV1, "grants"> | undefined;
  spec: SavedAgentProposal["spec"];
  base: SavedAgentProposal["base"];
  nowMs: number;
  id?: string;
  /** Workspace roster for the spec 352 ownership check; absent REFUSES a proposal that wants ownership. */
  roster?: AgentOwnershipRosterV1;
}): SavedAgentProposalAdmission {
  // SDD 482 phase 5 — housekeeping runs HERE, on the one path that already writes to this directory,
  // rather than from a projection that a render could call a hundred times. It is still not a control:
  // every reader filters by expiry itself, so a workspace where this never ran behaves identically.
  // Wiring it is what stops expired files accumulating forever — and stops this being an exported
  // function with no caller, which is its own kind of debt.
  sweepExpiredSavedAgentProposals(input.workspaceRoot, input.nowMs);
  const queue = readLiveSavedAgentProposalQueue(input.workspaceRoot, input.nowMs);
  const at = new Date(input.nowMs).toISOString();

  // An untrusted file still OCCUPIES the queue, so it must still count. Skipping it would hand a
  // writer the exact bypass the reviewer described: corrupt a pending proposal and it becomes
  // invisible to collapse, so the same request returns with a fresh id and the ceiling never bites.
  // Failing closed here costs a proposer three slots in a workspace someone can already write to,
  // and the refusal says why rather than looking like an unexplained limit.
  if (queue.unreadable.length > 0) {
    appendSavedAgentProposalWitness(input.workspaceRoot, { kind: "unreadable", ids: queue.unreadable.map((u) => u.id), at });
  }
  const admission = admitSavedAgentProposal({
    proposer: input.proposer,
    proposerProfile: input.proposerProfile,
    spec: input.spec,
    base: input.base,
    pending: queue.proposals,
    untrustedPending: queue.unreadable.length,
    ...(input.roster ? { roster: input.roster } : {}),
    nowMs: input.nowMs,
    id: input.id ?? newSavedAgentProposalId(),
  });
  if (!admission.ok) {
    appendSavedAgentProposalWitness(input.workspaceRoot, { kind: "refused", proposer: input.proposer, code: admission.code, at });
    return admission;
  }
  if (admission.collapsedOnto) {
    appendSavedAgentProposalWitness(input.workspaceRoot, {
      kind: "collapsed", id: admission.proposal.id, proposer: input.proposer, digest: admission.proposal.digest, at,
    });
    return admission;
  }
  writeAtomic(
    savedAgentProposalPath(input.workspaceRoot, admission.proposal.id),
    `${JSON.stringify(admission.proposal, null, 2)}\n`,
  );
  appendSavedAgentProposalWitness(input.workspaceRoot, {
    kind: "proposed", id: admission.proposal.id, proposer: input.proposer, digest: admission.proposal.digest, at,
  });
  return admission;
}

/**
 * Withdrawal by the PROPOSER. A third agent cancelling someone else's proposal would be a way to
 * suppress a human decision without ever being seen doing it, so ownership is checked here rather
 * than trusted from the caller.
 *
 * Cancelling an id that is already gone SUCCEEDS: a retry after a crash must converge rather than
 * report a failure that the caller can do nothing about.
 */
export function cancelSavedAgentProposal(input: {
  workspaceRoot: string;
  id: string;
  by: string;
  reason: string;
  nowMs: number;
}): { cancelled: boolean } {
  assertId(input.id);
  const file = savedAgentProposalPath(input.workspaceRoot, input.id);
  if (!fs.existsSync(file)) return { cancelled: false };
  const record = readSavedAgentProposal(input.workspaceRoot, input.id);
  if (record.proposer !== input.by) {
    throw new Error(`agent '${input.by}' cannot cancel a Saved Agent proposal owned by '${record.proposer}'`);
  }
  fs.rmSync(file, { force: true });
  appendSavedAgentProposalWitness(input.workspaceRoot, {
    kind: "cancelled", id: input.id, by: input.by, reason: input.reason, at: new Date(input.nowMs).toISOString(),
  });
  return { cancelled: true };
}

/**
 * Drops proposals past their expiry. Sweeping is HOUSEKEEPING, not a control: nothing may depend on
 * it having run, which is why every reader filters by expiry itself. If the sweep is what kept an
 * expired proposal from being honoured, then a host that never swept would honour it.
 */
export function sweepExpiredSavedAgentProposals(workspaceRoot: string, nowMs: number): string[] {
  const swept: string[] = [];
  const at = new Date(nowMs).toISOString();
  for (const proposal of listSavedAgentProposals(workspaceRoot)) {
    if (!savedAgentProposalIsExpired(proposal, nowMs)) continue;
    fs.rmSync(savedAgentProposalPath(workspaceRoot, proposal.id), { force: true });
    appendSavedAgentProposalWitness(workspaceRoot, {
      kind: "expired",
      id: proposal.id,
      digest: proposal.digest,
      proposer: proposal.proposer,
      agentName: proposal.spec.name,
      at,
    });
    swept.push(proposal.id);
  }
  return swept;
}

export interface SavedAgentProposalReceiptRecord {
  digest: string;
  proposalId: string;
  proposer: string;
  approvedBy: string;
  agentName: string;
  approvedAt: string;
  outcome: string;
  rationale?: string;
  runtimeAdapter?: string;
}

export function listSavedAgentProposalReceipts(workspaceRoot: string): SavedAgentProposalReceiptRecord[] {
  return readReceiptDir(path.join(workspaceRoot, SAVED_AGENT_RECEIPTS_REL_DIR));
}

function readReceiptDir(dir: string): SavedAgentProposalReceiptRecord[] {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SavedAgentProposalReceiptRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as Record<string, unknown>;
      if (typeof raw.digest !== "string" || typeof raw.proposalId !== "string") continue;
      if (typeof raw.proposer !== "string" || typeof raw.agentName !== "string") continue;
      if (typeof raw.approvedBy !== "string" || typeof raw.approvedAt !== "string") continue;
      if (typeof raw.outcome !== "string") continue;
      out.push({
        digest: raw.digest,
        proposalId: raw.proposalId,
        proposer: raw.proposer,
        approvedBy: raw.approvedBy,
        agentName: raw.agentName,
        approvedAt: raw.approvedAt,
        outcome: raw.outcome,
        ...(typeof raw.rationale === "string" ? { rationale: raw.rationale } : {}),
        ...(typeof raw.runtimeAdapter === "string" ? { runtimeAdapter: raw.runtimeAdapter } : {}),
      });
    } catch {
      /* a corrupt receipt is not a decision we can show */
    }
  }
  return out;
}

/**
 * t-00aa76 / t-ea8f78 — every terminal outcome a proposer can tell apart, from receipts + witness
 * + expired-but-still-on-disk files. Live pending proposals are NOT included.
 */
export function listSavedAgentProposalDecisions(
  workspaceRoot: string,
  nowMs: number,
): SavedAgentProposalDecisionRecord[] {
  const byId = new Map<string, SavedAgentProposalDecisionRecord>();

  for (const event of readSavedAgentProposalWitness(workspaceRoot)) {
    if (event.kind === "denied") {
      byId.set(event.id, {
        id: event.id,
        digest: event.digest,
        proposer: event.proposer,
        agentName: event.agentName,
        outcome: "denied",
        resolvedAt: event.at,
        decidedBy: event.deniedBy,
        operation: "create",
      });
    } else if (event.kind === "cancelled") {
      const denied = event.reason.startsWith("denied by ");
      byId.set(event.id, {
        id: event.id,
        digest: "",
        proposer: event.by,
        agentName: event.agentName ?? event.id,
        outcome: denied ? "denied" : "cancelled",
        resolvedAt: event.at,
        decidedBy: denied ? event.reason.slice("denied by ".length).split(":")[0] ?? event.by : event.by,
        operation: "create",
      });
    } else if (event.kind === "expired") {
      byId.set(event.id, {
        id: event.id,
        digest: event.digest,
        proposer: event.proposer,
        agentName: event.agentName,
        outcome: "expired",
        resolvedAt: event.at,
        decidedBy: "expiry",
        operation: "create",
      });
    }
  }

  for (const proposal of listSavedAgentProposals(workspaceRoot)) {
    if (!savedAgentProposalIsExpired(proposal, nowMs) || byId.has(proposal.id)) continue;
    byId.set(proposal.id, {
      id: proposal.id,
      digest: proposal.digest,
      proposer: proposal.proposer,
      agentName: proposal.spec.name,
      outcome: "expired",
      resolvedAt: proposal.expiresAt,
      decidedBy: "expiry",
      operation: "create",
      rationale: proposal.spec.rationale,
      runtimeAdapter: proposal.spec.runtimeAdapter,
    });
  }

  for (const receipt of listSavedAgentProposalReceipts(workspaceRoot)) {
    if (receipt.outcome !== "committed") continue;
    byId.set(receipt.proposalId, {
      id: receipt.proposalId,
      digest: receipt.digest,
      proposer: receipt.proposer,
      agentName: receipt.agentName,
      outcome: "approved",
      resolvedAt: receipt.approvedAt,
      decidedBy: receipt.approvedBy,
      operation: "create",
      ...(receipt.rationale ? { rationale: receipt.rationale } : {}),
      ...(receipt.runtimeAdapter ? { runtimeAdapter: receipt.runtimeAdapter } : {}),
    });
  }

  return [...byId.values()].sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.id.localeCompare(b.id));
}
