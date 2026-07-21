/**
 * Companion protocol constants + types (SDD 414 slice 2).
 * Client mirror lives in cfpperche/tachyon-companion packages/protocol.
 * Server owns semantics; bump only in lockstep with that package.
 */

/** SDD 420 foundation: tabId + refs + envelope. Pair fails closed on mismatch. */
export const COMPANION_PROTOCOL_VERSION = 2 as const;
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

/**
 * Host-facing device row for Control → Settings (Connected devices).
 * Never includes the session token — only a short opaque id.
 */
export interface CompanionDeviceRow {
  id: string;
  kind: CompanionClientInfo["kind"];
  name: string;
  version: string;
  pairedAt: string;
  expiresAt?: string;
  /** True when at least one SSE /events client is attached for this session. */
  live: boolean;
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

/** Opaque companion tab handle (never raw Chrome tab id on the agent wire). */
export type CompanionTabId = string;

/** Target fields shared by tab-scoped commands (SDD 420). */
export interface CompanionTabTarget {
  /** Opaque handle from tabs_list / snapshot. */
  tabId: string;
  /** Optional document generation token; mismatch → stale_tab. */
  expectedDocumentToken?: string;
}

/** Engine → extension: read, act, or first-person capture (tab-scoped). */
export type CompanionTabCommand =
  | { id: string; kind: "tabs_list"; at: string }
  | ({ id: string; kind: "snapshot"; at: string } & CompanionTabTarget)
  | ({
      id: string;
      kind: "screenshot";
      at: string;
      format?: "jpeg" | "png";
      quality?: number;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "click";
      at: string;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "type";
      at: string;
      ref?: string;
      selector?: string;
      text: string;
      submit?: boolean;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "fill";
      at: string;
      ref?: string;
      selector?: string;
      value: string;
    } & CompanionTabTarget)
  | ({ id: string; kind: "eval"; at: string; expression: string } & CompanionTabTarget)
  | ({ id: string; kind: "console"; at: string; limit?: number } & CompanionTabTarget)
  | ({
      id: string;
      kind: "navigate";
      at: string;
      action: "goto" | "back" | "forward" | "reload";
      url?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "scroll";
      at: string;
      direction?: "up" | "down" | "left" | "right";
      pixels?: number;
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "press_key";
      at: string;
      key: string;
      modifiers?: string[];
      ref?: string;
      selector?: string;
    } & CompanionTabTarget)
  | ({
      id: string;
      kind: "wait_for";
      at: string;
      what: "element" | "text" | "navigation" | "load";
      ref?: string;
      selector?: string;
      text?: string;
      timeoutMs?: number;
    } & CompanionTabTarget)
  | {
      id: string;
      kind: "tab_open";
      at: string;
      url?: string;
      active?: boolean;
    }
  | ({ id: string; kind: "tab_activate"; at: string } & CompanionTabTarget)
  | ({ id: string; kind: "tab_close"; at: string } & CompanionTabTarget);

export type CompanionTabErrorCode =
  | "timeout"
  | "offline"
  | "denied"
  | "restricted"
  | "no_tab"
  | "inject_failed"
  | "not_found"
  | "not_applied"
  | "stale_tab"
  | "stale_ref"
  | "needs_confirm"
  | "unknown_outcome"
  | "unknown";

export interface CompanionTabRefEntry {
  ref: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
}

/** Extension → engine: fulfillment of a tab command. */
export type CompanionTabResult =
  | {
      ok: true;
      id: string;
      kind: "tabs_list";
      tabs: Array<{
        tabId: string;
        title: string;
        url: string;
        active: boolean;
        documentToken: string;
      }>;
    }
  | {
      ok: true;
      id: string;
      kind: "snapshot";
      tabId: string;
      documentToken: string;
      url: string;
      title: string;
      capturedAt: string;
      selection?: string;
      outline: string;
      refs?: CompanionTabRefEntry[];
      stats: { nodes: number; truncated: boolean; outlineChars: number };
    }
  | {
      ok: true;
      id: string;
      kind: "screenshot";
      tabId: string;
      documentToken?: string;
      url: string;
      title: string;
      capturedAt: string;
      dataUrl: string;
      byteLength: number;
      mimeType: string;
    }
  | {
      ok: true;
      id: string;
      kind: "click" | "type" | "fill";
      tabId: string;
      documentToken?: string;
      ref?: string;
      selector?: string;
      url?: string;
      urlBefore?: string;
      urlAfter?: string;
      detail?: string;
      verified?: boolean;
      visibleText?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "eval";
      tabId: string;
      documentToken?: string;
      expression: string;
      result: string;
      url?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "console";
      tabId: string;
      documentToken?: string;
      url?: string;
      entries: Array<{ level: string; text: string; at?: string }>;
    }
  | {
      ok: true;
      id: string;
      kind: "navigate" | "scroll" | "press_key" | "wait_for" | "tab_activate" | "tab_close";
      tabId: string;
      documentToken?: string;
      url?: string;
      urlBefore?: string;
      urlAfter?: string;
      detail?: string;
    }
  | {
      ok: true;
      id: string;
      kind: "tab_open";
      tabId: string;
      documentToken: string;
      url: string;
      title: string;
    }
  | {
      ok: false;
      id: string;
      code: CompanionTabErrorCode;
      message: string;
      tabId?: string;
      url?: string;
      documentToken?: string;
    };

/** @deprecated Use CompanionTabResult */
export type CompanionTabSnapshotResult = CompanionTabResult;
