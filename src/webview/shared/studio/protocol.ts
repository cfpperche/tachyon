/**
 * spec 350 T1 — the studio shell's host<->webview envelope. ONE discriminated union, versioned by
 * `studioProtocolVersion`, with a DISCIPLINED extension slot: core lifecycle messages are fixed (dueto F2),
 * an adapter registers its own domain messages as a typed union of explicit names, and the boundary decoder
 * fails closed on an unknown protocol version or an unrecognized message type — a typo or a stale webview
 * never silently no-ops, it surfaces as a decode failure the caller must handle.
 *
 * Domain messages MAY NOT reuse a core name (enforced here by `assertNoDomainNameCollision`, exercised by a
 * lint-style test in studioShell.test.ts) — otherwise the three studio dialects just move their duplication
 * inside the envelope instead of removing it.
 */

export const STUDIO_PROTOCOL_VERSION = 1;

/** The reserved core message names — lifecycle, dirty tracking, validation/save/cancel/error. A domain union
 *  registering any of these is a spec violation, not a naming coincidence. */
export const CORE_MESSAGE_TYPES = ["ready", "load", "patch", "save", "cancel", "error", "dirty", "restore"] as const;
export type CoreMessageType = (typeof CORE_MESSAGE_TYPES)[number];

const CORE_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(CORE_MESSAGE_TYPES);

export function isCoreMessageType(type: string): type is CoreMessageType {
  return CORE_MESSAGE_TYPE_SET.has(type);
}

/** Throws if a registered domain name collides with a core message name. Adapters call this once at module
 *  scope (or a test calls it directly) so a collision fails loudly at the point of registration. */
export function assertNoDomainNameCollision(domainNames: readonly string[]): void {
  for (const name of domainNames) {
    if (isCoreMessageType(name)) {
      throw new Error(`studio domain message "${name}" collides with a reserved core message name`);
    }
  }
}

/** Every message on the wire carries the protocol version — the boundary decoder is what enforces it. */
export interface StudioEnvelope {
  studioProtocolVersion: number;
}

export interface StudioConcurrencyState {
  kind: "none" | "cas";
  /** present only for `kind: "cas"` — the revision/hash the host loaded, echoed back as the save precondition. */
  expected?: string;
  stale?: boolean;
}

export interface StudioRestoreSnapshot<TEntityId, TPatch> {
  schemaVersion: 1;
  entityType: string;
  mode: "new" | "edit";
  entityId?: TEntityId;
  /** present only when the adapter permits patch restore AND the panel was dirty at capture time. */
  patch?: TPatch;
}

/** Host -> webview core messages. `TEntity`/`TPatch` are the adapter's domain shapes. */
export type StudioHostCoreMessage<TEntity, TEntityId, TPatch> =
  | ({
      type: "load";
      entity: TEntity;
      concurrency: StudioConcurrencyState;
      /** host-known fact that a save for this entity is already in flight (e.g. another window) — the
       *  webview seeds its local save-gate with this rather than only ever setting it from its own Save
       *  click. Absent/false in the common case. */
      saveInFlight?: boolean;
    } & StudioEnvelope)
  | ({ type: "error"; code: string; message: string; blocking: boolean } & StudioEnvelope)
  | ({ type: "restore"; snapshot: StudioRestoreSnapshot<TEntityId, TPatch> | null } & StudioEnvelope)
  | ({ type: "save"; status: "ok" } & StudioEnvelope);

/** Webview -> host core messages. */
export type StudioWebviewCoreMessage<TPatch> =
  | ({ type: "ready" } & StudioEnvelope)
  | ({ type: "patch"; patch: TPatch } & StudioEnvelope)
  | ({ type: "save" } & StudioEnvelope)
  | ({ type: "cancel" } & StudioEnvelope)
  | ({ type: "dirty"; dirty: boolean } & StudioEnvelope);

/** A registered domain message: adapters union their own `{ type: "<name>"; ... }` shapes with this to get
 *  the envelope field for free — never re-declare `studioProtocolVersion` by hand. */
export type StudioDomainMessage<T extends { type: string }> = T & StudioEnvelope;

export interface StudioDecodeResult<T> {
  ok: boolean;
  message?: T;
  reason?: "not-an-object" | "missing-type" | "unknown-protocol-version" | "unknown-message-type";
}

/** The ONE boundary decoder both host and webview run inbound messages through. Fails closed: a message
 *  missing a recognizable shape, carrying a foreign protocol version, or naming a type outside core+domain
 *  is rejected rather than guessed at. */
export function decodeStudioMessage<T extends { type: string }>(raw: unknown, domainNames: readonly string[]): StudioDecodeResult<T> {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not-an-object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string") return { ok: false, reason: "missing-type" };
  if (r.studioProtocolVersion !== STUDIO_PROTOCOL_VERSION) return { ok: false, reason: "unknown-protocol-version" };
  if (!isCoreMessageType(r.type) && !domainNames.includes(r.type)) return { ok: false, reason: "unknown-message-type" };
  return { ok: true, message: raw as T };
}

/** Stamps the envelope onto a bare message — the one sanctioned construction site, so a constructor typo
 *  can't ship a message missing `studioProtocolVersion`. */
export function envelope<T extends { type: string }>(message: T): T & StudioEnvelope {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}
