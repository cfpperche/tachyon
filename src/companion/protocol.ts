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
