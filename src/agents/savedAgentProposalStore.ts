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
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";

/**
 * SDD 482 phase 4 slice B (`t-5e1113`) — where a proposal LIVES, and what a restart does to it.
 *
 * Ratified decision 4: a pending proposal lives 24h, survives a restart, collapses an identical
 * digest, and is invalidated when its base state diverges. Slice A made those pure decisions; this
 * makes them durable, which is where each of them can actually fail.
 *
 * ## Still no agent-reachable door
 *
 * There is no Bridge tool here either. The rule from slice A holds and gets stricter as the machinery
 * grows: the door opens in ONE slice, complete, or it does not open. What this file adds is the
 * host's own storage — the thing a Human Inbox will read and a commit path will consume — not a way
 * for an agent to put something into it.
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
export const SAVED_AGENT_PROPOSAL_WITNESS_REL_PATH = path.join(".tachyon", "agent-proposals.jsonl");
export const SAVED_AGENT_PROPOSAL_ID_PREFIX = "sp-";

export type SavedAgentProposalWitnessEvent =
  | { kind: "proposed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "collapsed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "cancelled"; id: string; by: string; reason: string; at: string }
  | { kind: "refused"; proposer: string; code: string; at: string };

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
 * Loads one proposal and re-derives its digest. A record whose digest does not match its own fields is
 * REFUSED, not repaired: recomputing the digest would launder exactly the edit this check exists to
 * catch, and an approval already bound to the old digest would then apply to different content.
 */
export function readSavedAgentProposal(workspaceRoot: string, id: string): SavedAgentProposal {
  assertId(id);
  const file = savedAgentProposalPath(workspaceRoot, id);
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

/**
 * Every proposal still on disk, tampered ones EXCLUDED rather than thrown.
 *
 * The asymmetry with `readSavedAgentProposal` is deliberate. Asking for one proposal by id must fail
 * loudly, because a caller is about to act on that exact one. Listing is what the ceiling and the
 * Inbox use, and there one corrupt file must not make the whole queue unreadable — which would turn a
 * single bad write into a denial of the human's ability to see anything at all.
 */
export function listSavedAgentProposals(workspaceRoot: string): SavedAgentProposal[] {
  const dir = path.join(workspaceRoot, SAVED_AGENT_PROPOSALS_REL_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: SavedAgentProposal[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) continue;
    try { out.push(readSavedAgentProposal(workspaceRoot, id)); } catch { /* tampered or unreadable: not listed */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Live = on disk and not past its expiry. Expiry is evaluated at READ time, so a restart cannot revive one. */
export function listLiveSavedAgentProposals(workspaceRoot: string, nowMs: number): SavedAgentProposal[] {
  return listSavedAgentProposals(workspaceRoot).filter((p) => !savedAgentProposalIsExpired(p, nowMs));
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
}): SavedAgentProposalAdmission {
  const admission = admitSavedAgentProposal({
    proposer: input.proposer,
    proposerProfile: input.proposerProfile,
    spec: input.spec,
    base: input.base,
    pending: listLiveSavedAgentProposals(input.workspaceRoot, input.nowMs),
    nowMs: input.nowMs,
    id: input.id ?? newSavedAgentProposalId(),
  });
  const at = new Date(input.nowMs).toISOString();
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
  for (const proposal of listSavedAgentProposals(workspaceRoot)) {
    if (!savedAgentProposalIsExpired(proposal, nowMs)) continue;
    fs.rmSync(savedAgentProposalPath(workspaceRoot, proposal.id), { force: true });
    swept.push(proposal.id);
  }
  return swept;
}
