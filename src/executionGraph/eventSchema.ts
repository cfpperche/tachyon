/**
 * SDD 480 Phase 2, slice 1 — the execution event, and the write boundary that sanitizes it.
 *
 * Pure module: no fs, no journal, no spawn seams. It owns the SHAPE of an execution event and the
 * one function that turns a raw observation into something safe to persist. Everything that writes
 * (the ledger, later slices) goes through `sealExecutionEvent` — a sanitizer that is easy to route
 * around is not a sanitizer.
 *
 * Two rules from the spec are enforced here rather than left to callers:
 *
 *  - §2 attribution is proven or `unproven`, never inferred. `provenance` is REQUIRED on every
 *    event, so an emitter cannot forget to say how it knows. There is no default.
 *  - §4.5 command/args/env are redacted BEFORE persistence. `sealExecutionEvent` is the only
 *    constructor, and it redacts on the way in, so a raw argv never reaches a caller holding a
 *    sealed event.
 */

import { redactSecrets } from "../bridge/redact.js";
import { containsUnsafeFramingCharacter } from "../config/framingSafety.js";

/** SDD 480 §4.2 — the node kinds an execution graph is built from. */
export type ExecutionNodeKind =
  | "Agent" | "Session" | "Turn" | "ToolCall"
  | "Process" | "TmuxSession" | "SystemdUnit" | "McpCall" | "InternalOperation";

/** SDD 480 §4.2 — how one node came to relate to another. */
export type ExecutionEdgeKind =
  | "spawned" | "invoked" | "attached" | "reparented" | "shared" | "completed" | "outlived";

/** SDD 480 §4.3 — what a node is doing. `unproven` is a state, not an absence. */
export type ExecutionState =
  | "running" | "waiting-input" | "completed" | "failed" | "killed" | "orphaned" | "shared" | "unproven";

/**
 * SDD 480 §4.3 — HOW the state was established, carried with the state itself.
 *
 * `measured`: Tachyon observed it. `declared`: a runtime asserted it and Tachyon trusts that runtime
 * for this specific fact. `unproven`: neither — the graph says so out loud instead of guessing.
 */
export type ExecutionProvenance = "measured" | "declared" | "unproven";

/** The lifecycle moments the ledger records (SDD 480 §4, plan 2.3). */
export type ExecutionEventKind =
  | "spawn" | "start" | "attach" | "exit" | "fail" | "orphan" | "share";

/** SDD 480 §4.1 — the ids that must travel, so attribution survives reparenting. */
export interface ExecutionCorrelation {
  agentId: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  executionId: string;
}

/** What an emitter observed, before sanitization. May carry secrets; never persist this. */
export interface RawExecutionEvent {
  kind: ExecutionEventKind;
  node: ExecutionNodeKind;
  state: ExecutionState;
  provenance: ExecutionProvenance;
  correlation: ExecutionCorrelation;
  at: string;
  /** Relation to the node that caused this one, when there is one. */
  edge?: { kind: ExecutionEdgeKind; toExecutionId: string };
  /** Free-form observation — command line, unit name, socket, exit code. Sanitized on seal. */
  detail?: Record<string, unknown>;
  /** Secrets the emitter already knows about, redacted in addition to the generic patterns. */
  knownSecrets?: readonly string[];
}

/** A sanitized event. The only shape the ledger accepts. */
export interface SealedExecutionEvent {
  kind: ExecutionEventKind;
  node: ExecutionNodeKind;
  state: ExecutionState;
  provenance: ExecutionProvenance;
  correlation: ExecutionCorrelation;
  at: string;
  edge?: { kind: ExecutionEdgeKind; toExecutionId: string };
  detail: Record<string, string>;
}

/** Detail values are capped so one runaway argv cannot dominate an agent's byte budget (§4.5). */
export const MAX_DETAIL_VALUE_CHARS = 512;
/** Beyond this many detail keys the emitter is logging a document, not an observation. */
export const MAX_DETAIL_KEYS = 24;

const ID_RE = /^[A-Za-z0-9][\w.:-]{0,127}$/;

function assertId(value: string, field: string): void {
  if (!ID_RE.test(value)) throw new Error(`execution event ${field} is not a usable id`);
}

/**
 * Render one detail value as a bounded, single-line, redacted string.
 *
 * Everything becomes a string on purpose: a detail is evidence for a human reading a graph, not a
 * typed payload for a consumer to branch on. Keeping it stringly means there is exactly one place
 * that has to be safe, instead of one per value type.
 */
function sealValue(value: unknown, knownSecrets: readonly string[]): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const redacted = redactSecrets(text, knownSecrets);
  // Control characters are stripped rather than rejected: a detail is diagnostic, and losing an
  // event because a command echoed a bell byte would be a worse outcome than losing the byte.
  const flat = containsUnsafeFramingCharacter(redacted)
    // eslint-disable-next-line no-control-regex
    ? redacted.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, " ")
    : redacted;
  return flat.length > MAX_DETAIL_VALUE_CHARS ? `${flat.slice(0, MAX_DETAIL_VALUE_CHARS - 1)}…` : flat;
}

/**
 * The write boundary. Validates correlation, redacts every detail, and returns the only shape the
 * ledger will accept.
 *
 * Throws on an unusable id — an event that cannot be correlated is worse than a missing one, because
 * it lands in the graph attached to nothing and looks like data.
 */
export function sealExecutionEvent(raw: RawExecutionEvent): SealedExecutionEvent {
  assertId(raw.correlation.agentId, "agentId");
  assertId(raw.correlation.executionId, "executionId");
  for (const [field, value] of [
    ["sessionId", raw.correlation.sessionId],
    ["turnId", raw.correlation.turnId],
    ["toolCallId", raw.correlation.toolCallId],
  ] as const) {
    if (value !== undefined) assertId(value, field);
  }
  if (raw.edge) assertId(raw.edge.toExecutionId, "edge.toExecutionId");
  if (!Number.isFinite(Date.parse(raw.at))) throw new Error("execution event timestamp is not a date");

  const secrets = raw.knownSecrets ?? [];
  const entries = Object.entries(raw.detail ?? {}).slice(0, MAX_DETAIL_KEYS);
  const detail: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    detail[sealValue(key, secrets)] = sealValue(value, secrets);
  }

  return {
    kind: raw.kind,
    node: raw.node,
    state: raw.state,
    provenance: raw.provenance,
    correlation: {
      agentId: raw.correlation.agentId,
      executionId: raw.correlation.executionId,
      ...(raw.correlation.sessionId ? { sessionId: raw.correlation.sessionId } : {}),
      ...(raw.correlation.turnId ? { turnId: raw.correlation.turnId } : {}),
      ...(raw.correlation.toolCallId ? { toolCallId: raw.correlation.toolCallId } : {}),
    },
    at: raw.at,
    ...(raw.edge ? { edge: { ...raw.edge } } : {}),
    detail,
  };
}

/**
 * SDD 480 §4.3 — a shared resource belongs to every agent using it and to none exclusively.
 *
 * Kept as a function rather than a field so no consumer can write "owner" and have it believed:
 * ownership is derived from the edges, and a `shared` node simply has more than one.
 */
export function isExclusivelyOwned(events: readonly SealedExecutionEvent[], executionId: string): boolean {
  const owners = new Set(
    events
      .filter((event) => event.correlation.executionId === executionId && event.state !== "unproven")
      .map((event) => event.correlation.agentId),
  );
  return owners.size === 1;
}
