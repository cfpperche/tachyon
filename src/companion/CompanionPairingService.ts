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
  type CompanionDeviceRow,
  type ConnectionStatus,
  type EngineIdentity,
  type IssuedPairCode,
  type PairRequestBody,
  type PairResponse,
} from "./protocol.js";
import { buildCompanionMobileOpenUrl, buildCompanionPairQrPayload } from "./pairQr.js";

export type CompanionPairBlockReason = "bridge_down" | "tailscale_required";

export interface CompanionPairingServiceOptions {
  /** Human-readable workspace label for the extension UI. */
  engineLabel: string;
  /** Stable engine/workspace id (e.g. wsHash). */
  engineId: string;
  /** Returns current primary base URL, or undefined if pairing is not possible. */
  getBaseUrl: () => string | undefined;
  /**
   * URL candidates for the pair payload (mobile: single Tailscale URL).
   * Defaults to [getBaseUrl()] when omitted.
   */
  getBaseUrlCandidates?: () => string[] | undefined;
  /**
   * When getBaseUrl() is undefined, optional reason for Control (Tailscale vs Bridge).
   */
  getPairBlockReason?: () => CompanionPairBlockReason | undefined;
  now?: () => number;
  pairCodeTtlMs?: number;
  sessionTtlMs?: number;
}

interface PendingCode {
  code: string;
  expiresAtMs: number;
}

interface ActiveSession {
  /** Short opaque id for host UI (never the bearer token). */
  id: string;
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
  issuePairCode(): IssuedPairCode | { ok: false; reason: CompanionPairBlockReason } {
    const base = this.options.getBaseUrl();
    if (!base) {
      return { ok: false, reason: this.options.getPairBlockReason?.() ?? "bridge_down" };
    }
    const code = newPairCode();
    const expiresAtMs = this.now() + this.pairCodeTtlMs;
    this.pending = { code, expiresAtMs };
    return this.buildIssuedPairCode(code, expiresAtMs)!;
  }

  /** Peek current pending code if still valid (for UI refresh without rotating). */
  peekPairCode(): IssuedPairCode | undefined {
    this.sweep();
    if (!this.pending) return undefined;
    return this.buildIssuedPairCode(this.pending.code, this.pending.expiresAtMs);
  }

  private buildIssuedPairCode(code: string, expiresAtMs?: number): IssuedPairCode | undefined {
    const baseUrl = this.options.getBaseUrl()?.replace(/\/+$/, "");
    if (!baseUrl) return undefined;
    const candidates = (this.options.getBaseUrlCandidates?.() ?? [baseUrl])
      .map((u) => u.replace(/\/+$/, ""))
      .filter(Boolean);
    const baseUrls = candidates.length > 0 ? [...new Set([baseUrl, ...candidates])] : [baseUrl];
    // Prefer primary first in the list for stable UI ordering.
    const ordered = [baseUrl, ...baseUrls.filter((u) => u !== baseUrl)];
    const exp = expiresAtMs ?? this.now() + this.pairCodeTtlMs;
    const protocolVersion = COMPANION_PROTOCOL_VERSION;
    const qrPayload = buildCompanionPairQrPayload({
      baseUrl,
      baseUrls: ordered,
      pairCode: code,
      protocolVersion,
    });
    return {
      code,
      expiresAt: new Date(exp).toISOString(),
      baseUrl,
      baseUrls: ordered,
      protocolVersion,
      qrPayload,
      openUrl: buildCompanionMobileOpenUrl(baseUrl, qrPayload),
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
      id: randomBytes(6).toString("hex"),
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

  /**
   * Host Control view: 0–1 device rows (array shaped for future multi-device).
   * `isLive` reports whether the session has an open companion SSE stream.
   */
  listDevices(isLive?: (sessionToken: string) => boolean): CompanionDeviceRow[] {
    this.sweep();
    const s = this.session;
    if (!s) return [];
    return [
      {
        id: s.id,
        kind: s.client.kind,
        name: s.client.name,
        version: s.client.version,
        pairedAt: new Date(s.pairedAtMs).toISOString(),
        expiresAt: new Date(s.expiresAtMs).toISOString(),
        live: isLive?.(s.token) === true,
      },
    ];
  }

  /**
   * Host-authoritative unpair (Control). Does not require the device's session token.
   * Returns the cleared token so callers can drop SSE clients.
   */
  forceUnpair(): { ok: true; hadSession: boolean; sessionToken?: string } {
    this.sweep();
    if (!this.session) return { ok: true, hadSession: false };
    const sessionToken = this.session.token;
    this.session = undefined;
    return { ok: true, hadSession: true, sessionToken };
  }

  private sweep(): void {
    const t = this.now();
    if (this.pending && t > this.pending.expiresAtMs) this.pending = undefined;
    if (this.session && t > this.session.expiresAtMs) this.session = undefined;
  }
}
