/**
 * Companion pairing authority (SDD 414 slice 2).
 * Issues short-lived pair codes and companion-scoped session tokens.
 * Distinct from agent Bridge tokens — never reuse TACHYON_BRIDGE_TOKEN.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  COMPANION_PROTOCOL_VERSION,
  PAIR_CODE_TTL_MS,
  SESSION_TTL_MS,
  type CompanionClientInfo,
  type ConnectionStatus,
  type EngineIdentity,
  type IssuedPairCode,
  type PairRequestBody,
  type PairResponse,
} from "./protocol.js";

export interface CompanionPairingServiceOptions {
  /** Human-readable workspace label for the extension UI. */
  engineLabel: string;
  /** Stable engine/workspace id (e.g. wsHash). */
  engineId: string;
  /** Returns current loopback base URL, or undefined if Bridge is down. */
  getBaseUrl: () => string | undefined;
  now?: () => number;
  pairCodeTtlMs?: number;
  sessionTtlMs?: number;
}

interface PendingCode {
  code: string;
  expiresAtMs: number;
}

interface ActiveSession {
  token: string;
  expiresAtMs: number;
  client: CompanionClientInfo;
  pairedAtMs: number;
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function newPairCode(): string {
  // 8 chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export class CompanionPairingService {
  private pending: PendingCode | undefined;
  private session: ActiveSession | undefined;
  private readonly now: () => number;
  private readonly pairCodeTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(private readonly options: CompanionPairingServiceOptions) {
    this.now = options.now ?? Date.now;
    this.pairCodeTtlMs = options.pairCodeTtlMs ?? PAIR_CODE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  get protocolVersion(): number {
    return COMPANION_PROTOCOL_VERSION;
  }

  engineIdentity(): EngineIdentity {
    return {
      label: this.options.engineLabel,
      engineId: this.options.engineId,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  /**
   * Mint a new short-lived pair code. Invalidates any previous unused code.
   * Does not invalidate an existing companion session until a new pair succeeds.
   */
  issuePairCode(): IssuedPairCode | { ok: false; reason: "bridge_down" } {
    const baseUrl = this.options.getBaseUrl();
    if (!baseUrl) return { ok: false, reason: "bridge_down" };
    const code = newPairCode();
    const expiresAtMs = this.now() + this.pairCodeTtlMs;
    this.pending = { code, expiresAtMs };
    return {
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
      baseUrl,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  /** Peek current pending code if still valid (for UI refresh without rotating). */
  peekPairCode(): IssuedPairCode | undefined {
    this.sweep();
    const baseUrl = this.options.getBaseUrl();
    if (!this.pending || !baseUrl) return undefined;
    return {
      code: this.pending.code,
      expiresAt: new Date(this.pending.expiresAtMs).toISOString(),
      baseUrl,
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  pair(body: PairRequestBody): PairResponse {
    // Do not sweep pending codes here — pair() reports expired_code explicitly.
    if (this.session && this.now() > this.session.expiresAtMs) this.session = undefined;
    if (body.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
      return {
        ok: false,
        code: "protocol_mismatch",
        message: `Client protocol ${body.protocolVersion} is incompatible with server protocol ${COMPANION_PROTOCOL_VERSION}. Update Tachyon Companion or the Tachyon engine.`,
        serverProtocolVersion: COMPANION_PROTOCOL_VERSION,
      };
    }
    if (!this.options.getBaseUrl()) {
      return {
        ok: false,
        code: "engine_offline",
        message: "Companion HTTP surface is not listening (engine/Bridge down).",
      };
    }
    const offered = body.pairCode?.trim().toUpperCase() ?? "";
    if (!this.pending) {
      return {
        ok: false,
        code: "invalid_code",
        message: "No active pair code. Generate a new code in Tachyon (Pair Companion).",
      };
    }
    // Expiry before match so a late submit of the real code gets expired_code, not a silent wipe + invalid.
    if (this.now() > this.pending.expiresAtMs) {
      this.pending = undefined;
      return {
        ok: false,
        code: "expired_code",
        message: "Pair code expired. Generate a new code in Tachyon.",
      };
    }
    if (!offered || !safeEqualStr(offered, this.pending.code)) {
      return {
        ok: false,
        code: "invalid_code",
        message: "Pair code does not match. Check the code shown in Tachyon.",
      };
    }
    // One active pair: replace any prior session.
    const token = newSessionToken();
    const expiresAtMs = this.now() + this.sessionTtlMs;
    this.session = {
      token,
      expiresAtMs,
      client: body.client,
      pairedAtMs: this.now(),
    };
    this.pending = undefined;
    return {
      ok: true,
      sessionToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      engine: this.engineIdentity(),
    };
  }

  unpair(sessionToken: string | undefined): { ok: true } | { ok: false; code: "unpaired" | "expired"; message: string } {
    this.sweep();
    if (!sessionToken || !this.session) {
      this.session = undefined;
      return { ok: true };
    }
    if (!safeEqualStr(sessionToken, this.session.token)) {
      return { ok: false, code: "unpaired", message: "Unknown companion session." };
    }
    this.session = undefined;
    return { ok: true };
  }

  status(sessionToken: string | undefined): ConnectionStatus {
    this.sweep();
    if (!sessionToken || !this.session) {
      return { status: "disconnected", protocolVersion: COMPANION_PROTOCOL_VERSION };
    }
    if (!safeEqualStr(sessionToken, this.session.token)) {
      return {
        status: "error",
        lastError: "Unknown companion session.",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
      };
    }
    return {
      status: "connected",
      engine: this.engineIdentity(),
      expiresAt: new Date(this.session.expiresAtMs).toISOString(),
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  /** True when bearer is a live companion session (for future capture/approvals). */
  authorizeSession(sessionToken: string | undefined): boolean {
    this.sweep();
    if (!sessionToken || !this.session) return false;
    return safeEqualStr(sessionToken, this.session.token);
  }

  /**
   * True when a Companion device is currently paired (session not expired).
   * Used to gate agent-facing browser tools so they only appear when a device exists.
   */
  hasPairedDevice(): boolean {
    this.sweep();
    return this.session !== undefined;
  }

  activeClient(): CompanionClientInfo | undefined {
    this.sweep();
    return this.session?.client;
  }

  private sweep(): void {
    const t = this.now();
    if (this.pending && t > this.pending.expiresAtMs) this.pending = undefined;
    if (this.session && t > this.session.expiresAtMs) this.session = undefined;
  }
}
