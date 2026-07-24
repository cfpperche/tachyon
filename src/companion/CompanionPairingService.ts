/**
 * Companion pairing authority (SDD 414 slice 2 + 422 multi-kind).
 * Issues short-lived pair codes and companion-scoped session tokens.
 * Distinct from agent Bridge tokens — never reuse TACHYON_BRIDGE_TOKEN.
 *
 * Session policy (422 M4 follow-up t-44dfb6, probe-reviewed):
 * - At most one **browser** and one **mobile** session concurrently (keyed by client.kind).
 * - Pairing the same kind replaces that kind only; the other kind is left intact.
 * - status/authorize/unpair are token-scoped (caller's session only).
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
export type CompanionClientKind = CompanionClientInfo["kind"];

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

export type PairOutcome =
  | (Extract<PairResponse, { ok: true }> & { replacedSessionToken?: string })
  | Extract<PairResponse, { ok: false }>;

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

function isClientKind(v: unknown): v is CompanionClientKind {
  return v === "browser" || v === "mobile";
}

export class CompanionPairingService {
  private pending: PendingCode | undefined;
  /** At most one session per client.kind (browser | mobile). */
  private readonly sessions = new Map<CompanionClientKind, ActiveSession>();
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
   * Does not invalidate existing companion sessions until a new pair succeeds.
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

  /**
   * Pair a companion client. Same-kind replace only (browser vs mobile can co-exist).
   * Returns replacedSessionToken when a prior same-kind session was evicted (for SSE drop).
   */
  pair(body: PairRequestBody): PairOutcome {
    this.sweepSessionsOnly();
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
    const kind = body.client?.kind;
    if (!isClientKind(kind)) {
      return {
        ok: false,
        code: "unknown",
        message: "client.kind must be 'browser' or 'mobile'.",
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

    const prev = this.sessions.get(kind);
    const replacedSessionToken = prev?.token;
    const token = newSessionToken();
    const expiresAtMs = this.now() + this.sessionTtlMs;
    this.sessions.set(kind, {
      id: randomBytes(6).toString("hex"),
      token,
      expiresAtMs,
      client: {
        kind,
        name: typeof body.client.name === "string" ? body.client.name : kind,
        version: typeof body.client.version === "string" ? body.client.version : "0",
      },
      pairedAtMs: this.now(),
    });
    this.pending = undefined;
    return {
      ok: true,
      sessionToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      engine: this.engineIdentity(),
      ...(replacedSessionToken ? { replacedSessionToken } : {}),
    };
  }

  unpair(sessionToken: string | undefined): { ok: true } | { ok: false; code: "unpaired" | "expired"; message: string } {
    this.sweep();
    if (!sessionToken) return { ok: true };
    const hit = this.findByToken(sessionToken);
    if (!hit) {
      return { ok: false, code: "unpaired", message: "Unknown companion session." };
    }
    this.sessions.delete(hit.kind);
    return { ok: true };
  }

  /**
   * Status for the caller's session only (token-scoped).
   * Unknown token → error (not "the other device's" status).
   */
  status(sessionToken: string | undefined): ConnectionStatus {
    this.sweep();
    if (!sessionToken) {
      return { status: "disconnected", protocolVersion: COMPANION_PROTOCOL_VERSION };
    }
    const hit = this.findByToken(sessionToken);
    if (!hit) {
      return {
        status: "error",
        lastError: "Unknown companion session.",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
      };
    }
    return {
      status: "connected",
      engine: this.engineIdentity(),
      expiresAt: new Date(hit.session.expiresAtMs).toISOString(),
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    };
  }

  /** True when bearer is a live companion session. */
  authorizeSession(sessionToken: string | undefined): boolean {
    this.sweep();
    if (!sessionToken) return false;
    return this.findByToken(sessionToken) !== undefined;
  }

  /**
   * Kind of the session that owns this token (for SSE filtering / tab tools).
   */
  sessionKind(sessionToken: string | undefined): CompanionClientKind | undefined {
    this.sweep();
    if (!sessionToken) return undefined;
    return this.findByToken(sessionToken)?.kind;
  }

  /** Session tokens currently paired for a kind (0–1). */
  tokensForKind(kind: CompanionClientKind): string[] {
    this.sweep();
    const s = this.sessions.get(kind);
    return s ? [s.token] : [];
  }

  /**
   * True when any Companion device is paired.
   * Prefer {@link hasPairedKind} for capability gates.
   */
  hasPairedDevice(): boolean {
    this.sweep();
    return this.sessions.size > 0;
  }

  /** True when a session of this kind is live (not expired). */
  hasPairedKind(kind: CompanionClientKind): boolean {
    this.sweep();
    return this.sessions.has(kind);
  }

  /** Prefer browser client when both present (legacy single-client call sites). */
  activeClient(): CompanionClientInfo | undefined {
    this.sweep();
    return this.sessions.get("browser")?.client ?? this.sessions.get("mobile")?.client;
  }

  /**
   * Host Control view: 0–2 device rows (one per kind).
   * `isLive` reports whether the session has an open companion SSE stream.
   */
  listDevices(isLive?: (sessionToken: string) => boolean): CompanionDeviceRow[] {
    this.sweep();
    const rows: CompanionDeviceRow[] = [];
    for (const kind of ["browser", "mobile"] as const) {
      const s = this.sessions.get(kind);
      if (!s) continue;
      rows.push({
        id: s.id,
        kind: s.client.kind,
        name: s.client.name,
        version: s.client.version,
        pairedAt: new Date(s.pairedAtMs).toISOString(),
        expiresAt: new Date(s.expiresAtMs).toISOString(),
        live: isLive?.(s.token) === true,
      });
    }
    return rows;
  }

  /**
   * Host-authoritative unpair. Optional deviceId clears one row; omit clears all.
   * Returns every cleared token so callers can drop SSE clients.
   */
  forceUnpair(deviceId?: string): { ok: true; hadSession: boolean; sessionTokens: string[]; sessionToken?: string } {
    this.sweep();
    if (deviceId) {
      for (const [kind, s] of this.sessions) {
        if (s.id !== deviceId) continue;
        this.sessions.delete(kind);
        return {
          ok: true,
          hadSession: true,
          sessionTokens: [s.token],
          sessionToken: s.token,
        };
      }
      return { ok: true, hadSession: false, sessionTokens: [] };
    }
    if (this.sessions.size === 0) return { ok: true, hadSession: false, sessionTokens: [] };
    const sessionTokens = [...this.sessions.values()].map((s) => s.token);
    this.sessions.clear();
    return {
      ok: true,
      hadSession: true,
      sessionTokens,
      sessionToken: sessionTokens[0],
    };
  }

  private findByToken(sessionToken: string): { kind: CompanionClientKind; session: ActiveSession } | undefined {
    for (const [kind, s] of this.sessions) {
      if (safeEqualStr(sessionToken, s.token)) return { kind, session: s };
    }
    return undefined;
  }

  private sweepSessionsOnly(): void {
    const t = this.now();
    for (const [kind, s] of [...this.sessions]) {
      if (t > s.expiresAtMs) this.sessions.delete(kind);
    }
  }

  private sweep(): void {
    const t = this.now();
    if (this.pending && t > this.pending.expiresAtMs) this.pending = undefined;
    this.sweepSessionsOnly();
  }
}
