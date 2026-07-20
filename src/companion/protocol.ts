/**
 * Companion protocol constants + types (SDD 414 slice 2).
 * Client mirror lives in cfpperche/tachyon-companion packages/protocol.
 * Server owns semantics; bump only in lockstep with that package.
 */

export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_HTTP_PREFIX = "/companion/v1";

/** Pair code lifetime. */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** Companion session lifetime after successful pair. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type PairStatus = "disconnected" | "pairing" | "connected" | "expired" | "error";

export interface EngineIdentity {
  label: string;
  engineId?: string;
  protocolVersion: number;
}

export interface CompanionClientInfo {
  kind: "browser" | "mobile";
  name: string;
  version: string;
}

export interface PairRequestBody {
  pairCode: string;
  protocolVersion: number;
  client: CompanionClientInfo;
}

export type PairResponse =
  | {
      ok: true;
      sessionToken: string;
      expiresAt: string;
      engine: EngineIdentity;
    }
  | {
      ok: false;
      code:
        | "invalid_code"
        | "expired_code"
        | "protocol_mismatch"
        | "engine_offline"
        | "already_paired"
        | "unknown";
      message: string;
      serverProtocolVersion?: number;
    };

export interface ConnectionStatus {
  status: PairStatus;
  engine?: EngineIdentity;
  expiresAt?: string;
  lastError?: string;
  protocolVersion?: number;
}

export interface IssuedPairCode {
  code: string;
  expiresAt: string;
  /** Loopback base URL the extension should use (no trailing path). */
  baseUrl: string;
  protocolVersion: number;
}

/** Running agent row for Companion send-prompt UI (MVP item 3 — evolving). */
export interface CompanionAgentRow {
  name: string;
  /** Attention snapshot when known: idle | working | needs-input | throttled | … */
  attention: string;
  composerOccupied: boolean;
}

export type ListAgentsResponse =
  | { ok: true; agents: CompanionAgentRow[] }
  | { ok: false; code: "unpaired" | "expired" | "unknown"; message: string };

export interface SendPromptRequest {
  agent: string;
  text: string;
}

export type SendPromptResponse =
  | {
      ok: true;
      /** Immediate submit vs queued until idle (deliverNotice). */
      status: "notified" | "queued";
      agent: string;
      dropped?: number;
      queued?: number;
    }
  | {
      ok: false;
      code:
        | "unpaired"
        | "expired"
        | "not_agent"
        | "not_running"
        | "not_ready"
        | "empty"
        | "unknown";
      message: string;
    };

/** Pending human-approval summary for Companion UI (host-authoritative). */
export interface CompanionApprovalSummary {
  id: string;
  requester: string;
  reason: string;
  proposedAction: string;
  risk: string;
  exactPrompt: string;
  createdAt: string;
  status: "pending";
}

export type CompanionListApprovalsResponse =
  | { ok: true; approvals: CompanionApprovalSummary[] }
  | { ok: false; code: "unpaired" | "expired" | "unknown"; message: string };

export type CompanionResolveApprovalResponse =
  | { ok: true; id: string; status: "approved" | "denied"; injectError?: string }
  | {
      ok: false;
      code: "unpaired" | "expired" | "not_found" | "not_pending" | "unknown";
      message: string;
    };

/** Optional workspace ops for Companion HTTP (list agents + send prompt + approvals). */
export interface CompanionWorkspaceOps {
  listActiveAgents(): Promise<CompanionAgentRow[]>;
  sendPrompt(agent: string, text: string): Promise<SendPromptResponse>;
  listApprovals?(): Promise<CompanionApprovalSummary[]>;
  resolveApproval?(
    id: string,
    decision: "approved" | "denied",
  ): Promise<CompanionResolveApprovalResponse>;
}

/**
 * Live state pushed on GET /companion/v1/events (SSE).
 * Full snapshots (not deltas) — small payload on loopback; zero drift.
 */
export interface CompanionLiveState {
  seq: number;
  at: string;
  connection: ConnectionStatus;
  agents: CompanionAgentRow[];
}

/** Engine → extension: read or act on the user's active tab. */
export type CompanionTabCommand =
  | { id: string; kind: "snapshot"; at: string }
  | { id: string; kind: "click"; at: string; selector: string }
  | { id: string; kind: "type"; at: string; selector: string; text: string; submit?: boolean }
  | { id: string; kind: "fill"; at: string; selector: string; value: string };

export type CompanionTabErrorCode =
  | "timeout"
  | "offline"
  | "denied"
  | "restricted"
  | "no_tab"
  | "inject_failed"
  | "not_found"
  | "unknown";

/** Extension → engine: fulfillment of a tab command. */
export type CompanionTabResult =
  | {
      ok: true;
      id: string;
      kind: "snapshot";
      url: string;
      title: string;
      capturedAt: string;
      selection?: string;
      outline: string;
      stats: { nodes: number; truncated: boolean; outlineChars: number };
    }
  | {
      ok: true;
      id: string;
      kind: "click" | "type" | "fill";
      selector: string;
      url?: string;
      detail?: string;
    }
  | {
      ok: false;
      id: string;
      code: CompanionTabErrorCode;
      message: string;
      url?: string;
    };

/** @deprecated Use CompanionTabResult */
export type CompanionTabSnapshotResult = CompanionTabResult;
