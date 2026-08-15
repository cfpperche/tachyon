import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  admitSavedAgentRemovalProposal,
  computeSavedAgentRemovalProposalDigest,
  savedAgentRemovalProposalIsExpired,
  type SavedAgentRemovalProposal,
  type SavedAgentRemovalProposalAdmission,
  type SavedAgentRemovalTargetFacts,
} from "./savedAgentRemovalProposal.js";
import type { SavedAgentProposalDecisionRecord } from "./savedAgentProposalDecision.js";
import type { AgentProfileV1 } from "../config/agentProfileSchema.js";

/**
 * t-afe120 — durable queue for Saved Agent removal proposals.
 *
 * Separate directory and id prefix from create proposals so the two queues cannot collide, and so a
 * create digest can never be redeemed as a removal (or the reverse). Digest re-check on every read
 * is the same doctrine as the create store.
 */

export const SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR = path.join(".tachyon", "agent-removal-proposals");
export const SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR = path.join(SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR, "receipts");
export const SAVED_AGENT_REMOVAL_PROPOSAL_WITNESS_REL_PATH = path.join(".tachyon", "agent-removal-proposals.jsonl");
export const SAVED_AGENT_REMOVAL_PROPOSAL_ID_PREFIX = "sr-";

export type SavedAgentRemovalProposalWitnessEvent =
  | { kind: "proposed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "collapsed"; id: string; proposer: string; digest: string; at: string }
  | { kind: "cancelled"; id: string; by: string; reason: string; at: string; agentName?: string }
  | { kind: "denied"; id: string; digest: string; proposer: string; deniedBy: string; reason: string; agentName: string; at: string }
  | { kind: "expired"; id: string; digest: string; proposer: string; agentName: string; at: string }
  | { kind: "refused"; proposer: string; code: string; at: string }
  | { kind: "unreadable"; ids: string[]; at: string }
  | { kind: "committed"; id: string; digest: string; approvedBy: string; at: string };

export function newSavedAgentRemovalProposalId(): string {
  return `${SAVED_AGENT_REMOVAL_PROPOSAL_ID_PREFIX}${crypto.randomBytes(3).toString("hex")}`;
}

export function savedAgentRemovalProposalPath(workspaceRoot: string, id: string): string {
  return path.join(workspaceRoot, SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR, `${id}.json`);
}

const ID_RE = /^sr-[0-9a-f]{6}$/;

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid saved agent removal proposal id: ${JSON.stringify(id)}`);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* rename failure is the real error */ }
    throw error;
  }
}

export function appendSavedAgentRemovalProposalWitness(
  workspaceRoot: string,
  event: SavedAgentRemovalProposalWitnessEvent,
): void {
  const file = path.join(workspaceRoot, SAVED_AGENT_REMOVAL_PROPOSAL_WITNESS_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readSavedAgentRemovalProposalWitness(workspaceRoot: string): SavedAgentRemovalProposalWitnessEvent[] {
  const file = path.join(workspaceRoot, SAVED_AGENT_REMOVAL_PROPOSAL_WITNESS_REL_PATH);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line) as SavedAgentRemovalProposalWitnessEvent; } catch { return undefined; } })
    .filter((event): event is SavedAgentRemovalProposalWitnessEvent => !!event && typeof event.kind === "string");
}

export class SavedAgentRemovalProposalTamperError extends Error {
  readonly code = "saved_agent_removal_proposal_tampered";
}

export interface UnreadableSavedAgentRemovalProposal {
  id: string;
  reason: string;
}

export interface SavedAgentRemovalProposalListing {
  proposals: SavedAgentRemovalProposal[];
  unreadable: UnreadableSavedAgentRemovalProposal[];
}

function assertNotSymlink(target: string, what: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new SavedAgentRemovalProposalTamperError(
      `${what} is a symlink — refusing to read a Saved Agent removal proposal through one`,
    );
  }
}

export function readSavedAgentRemovalProposal(workspaceRoot: string, id: string): SavedAgentRemovalProposal {
  assertId(id);
  const dir = path.join(workspaceRoot, SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR);
  assertNotSymlink(dir, "the Saved Agent removal proposal directory");
  const file = savedAgentRemovalProposalPath(workspaceRoot, id);
  assertNotSymlink(file, `removal proposal '${id}'`);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as SavedAgentRemovalProposal;
  const expected = computeSavedAgentRemovalProposalDigest({
    proposer: record.proposer,
    spec: record.spec,
    base: record.base,
  });
  if (record.digest !== expected) {
    throw new SavedAgentRemovalProposalTamperError(
      `saved agent removal proposal '${id}' does not match its digest — refusing to honour an edited proposal`,
    );
  }
  if (record.id !== id) {
    throw new SavedAgentRemovalProposalTamperError(`saved agent removal proposal '${id}' carries a different id inside`);
  }
  return record;
}

export function listSavedAgentRemovalProposals(workspaceRoot: string): SavedAgentRemovalProposal[] {
  return readSavedAgentRemovalProposalQueue(workspaceRoot).proposals;
}

export function readSavedAgentRemovalProposalQueue(workspaceRoot: string): SavedAgentRemovalProposalListing {
  const dir = path.join(workspaceRoot, SAVED_AGENT_REMOVAL_PROPOSALS_REL_DIR);
  if (!fs.existsSync(dir)) return { proposals: [], unreadable: [] };
  const proposals: SavedAgentRemovalProposal[] = [];
  const unreadable: UnreadableSavedAgentRemovalProposal[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    return {
      proposals: [],
      unreadable: [{ id: "(directory)", reason: error instanceof Error ? error.message : String(error) }],
    };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_RE.test(id)) {
      unreadable.push({ id: entry, reason: "file name is not a valid removal proposal id" });
      continue;
    }
    try {
      proposals.push(readSavedAgentRemovalProposal(workspaceRoot, id));
    } catch (error) {
      unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  unreadable.sort((a, b) => a.id.localeCompare(b.id));
  return { proposals, unreadable };
}

export function listLiveSavedAgentRemovalProposals(workspaceRoot: string, nowMs: number): SavedAgentRemovalProposal[] {
  return listSavedAgentRemovalProposals(workspaceRoot).filter((p) => !savedAgentRemovalProposalIsExpired(p, nowMs));
}

export function readLiveSavedAgentRemovalProposalQueue(
  workspaceRoot: string,
  nowMs: number,
): SavedAgentRemovalProposalListing {
  const queue = readSavedAgentRemovalProposalQueue(workspaceRoot);
  return {
    proposals: queue.proposals.filter((p) => !savedAgentRemovalProposalIsExpired(p, nowMs)),
    unreadable: queue.unreadable,
  };
}

export function recordSavedAgentRemovalProposal(input: {
  workspaceRoot: string;
  proposer: string;
  proposerProfile: Pick<AgentProfileV1, "grants"> | undefined;
  spec: SavedAgentRemovalProposal["spec"];
  base: { configSha256: string };
  target: SavedAgentRemovalTargetFacts;
  nowMs: number;
  id?: string;
}): SavedAgentRemovalProposalAdmission {
  sweepExpiredSavedAgentRemovalProposals(input.workspaceRoot, input.nowMs);
  const queue = readLiveSavedAgentRemovalProposalQueue(input.workspaceRoot, input.nowMs);
  const at = new Date(input.nowMs).toISOString();

  if (queue.unreadable.length > 0) {
    appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
      kind: "unreadable",
      ids: queue.unreadable.map((u) => u.id),
      at,
    });
  }

  const admission = admitSavedAgentRemovalProposal({
    proposer: input.proposer,
    proposerProfile: input.proposerProfile,
    spec: input.spec,
    base: input.base,
    target: input.target,
    pending: queue.proposals,
    untrustedPending: queue.unreadable.length,
    nowMs: input.nowMs,
    id: input.id ?? newSavedAgentRemovalProposalId(),
  });

  if (!admission.ok) {
    appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
      kind: "refused",
      proposer: input.proposer,
      code: admission.code,
      at,
    });
    return admission;
  }
  if (admission.collapsedOnto) {
    appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
      kind: "collapsed",
      id: admission.proposal.id,
      proposer: input.proposer,
      digest: admission.proposal.digest,
      at,
    });
    return admission;
  }
  writeAtomic(
    savedAgentRemovalProposalPath(input.workspaceRoot, admission.proposal.id),
    `${JSON.stringify(admission.proposal, null, 2)}\n`,
  );
  appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
    kind: "proposed",
    id: admission.proposal.id,
    proposer: input.proposer,
    digest: admission.proposal.digest,
    at,
  });
  return admission;
}

export function cancelSavedAgentRemovalProposal(input: {
  workspaceRoot: string;
  id: string;
  by: string;
  reason: string;
  nowMs: number;
}): { cancelled: boolean } {
  assertId(input.id);
  const file = savedAgentRemovalProposalPath(input.workspaceRoot, input.id);
  if (!fs.existsSync(file)) return { cancelled: false };
  const record = readSavedAgentRemovalProposal(input.workspaceRoot, input.id);
  if (record.proposer !== input.by) {
    throw new Error(
      `agent '${input.by}' cannot cancel a Saved Agent removal proposal owned by '${record.proposer}'`,
    );
  }
  fs.rmSync(file, { force: true });
  appendSavedAgentRemovalProposalWitness(input.workspaceRoot, {
    kind: "cancelled",
    id: input.id,
    by: input.by,
    reason: input.reason,
    at: new Date(input.nowMs).toISOString(),
  });
  return { cancelled: true };
}

export function sweepExpiredSavedAgentRemovalProposals(workspaceRoot: string, nowMs: number): string[] {
  const swept: string[] = [];
  const at = new Date(nowMs).toISOString();
  for (const proposal of listSavedAgentRemovalProposals(workspaceRoot)) {
    if (!savedAgentRemovalProposalIsExpired(proposal, nowMs)) continue;
    fs.rmSync(savedAgentRemovalProposalPath(workspaceRoot, proposal.id), { force: true });
    appendSavedAgentRemovalProposalWitness(workspaceRoot, {
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

export interface SavedAgentRemovalProposalReceiptRecord {
  digest: string;
  proposalId: string;
  proposer: string;
  approvedBy: string;
  agentName: string;
  approvedAt: string;
  outcome: string;
}

export function listSavedAgentRemovalProposalReceipts(workspaceRoot: string): SavedAgentRemovalProposalReceiptRecord[] {
  const dir = path.join(workspaceRoot, SAVED_AGENT_REMOVAL_RECEIPTS_REL_DIR);
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SavedAgentRemovalProposalReceiptRecord[] = [];
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
      });
    } catch {
      /* a corrupt receipt is not a decision we can show */
    }
  }
  return out;
}

export function listSavedAgentRemovalProposalDecisions(
  workspaceRoot: string,
  nowMs: number,
): SavedAgentProposalDecisionRecord[] {
  const byId = new Map<string, SavedAgentProposalDecisionRecord>();

  for (const event of readSavedAgentRemovalProposalWitness(workspaceRoot)) {
    if (event.kind === "denied") {
      byId.set(event.id, {
        id: event.id,
        digest: event.digest,
        proposer: event.proposer,
        agentName: event.agentName,
        outcome: "denied",
        resolvedAt: event.at,
        resolvedBy: event.deniedBy,
        operation: "remove",
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
        resolvedBy: denied ? event.reason.slice("denied by ".length).split(":")[0] ?? event.by : event.by,
        operation: "remove",
      });
    } else if (event.kind === "expired") {
      byId.set(event.id, {
        id: event.id,
        digest: event.digest,
        proposer: event.proposer,
        agentName: event.agentName,
        outcome: "expired",
        resolvedAt: event.at,
        resolvedBy: "expiry",
        operation: "remove",
      });
    }
  }

  for (const proposal of listSavedAgentRemovalProposals(workspaceRoot)) {
    if (!savedAgentRemovalProposalIsExpired(proposal, nowMs) || byId.has(proposal.id)) continue;
    byId.set(proposal.id, {
      id: proposal.id,
      digest: proposal.digest,
      proposer: proposal.proposer,
      agentName: proposal.spec.name,
      outcome: "expired",
      resolvedAt: proposal.expiresAt,
      resolvedBy: "expiry",
      operation: "remove",
      rationale: proposal.spec.rationale,
    });
  }

  for (const receipt of listSavedAgentRemovalProposalReceipts(workspaceRoot)) {
    if (receipt.outcome !== "committed") continue;
    byId.set(receipt.proposalId, {
      id: receipt.proposalId,
      digest: receipt.digest,
      proposer: receipt.proposer,
      agentName: receipt.agentName,
      outcome: "approved",
      resolvedAt: receipt.approvedAt,
      resolvedBy: receipt.approvedBy,
      operation: "remove",
    });
  }

  return [...byId.values()].sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.id.localeCompare(b.id));
}
