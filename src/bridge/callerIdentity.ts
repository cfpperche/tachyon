import crypto from "node:crypto";

/**
 * spec 351 (layer B) — the Bridge RESOLVES the caller instead of trusting self-declared params. This
 * module is the whole decision (completeNode.ts's "pure validate, thin Bridge shell" precedent):
 * digest-only registry + resolution + the actor-vs-subject helper tools.ts wraps existing handlers with.
 *
 * Digest-only (dueto F2/F13): the registry NEVER stores a plaintext token — only a fixed-length
 * HMAC-SHA256 digest keyed by a machine-local secret (VS Code SecretStorage; see Workspace wiring).
 * `mint()` returns the plaintext ONCE; everything after that is compare-by-digest.
 */

/** The subset of EngineHost's SecretPort this module needs — kept minimal so tests don't need a real host. */
export interface SecretPort {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
}

const HMAC_KEY_SECRET_ID = "tachyon.callerIdentity.hmacKey";

/**
 * Machine-local HMAC key custody (dueto key-decision): created once via VS Code SecretStorage, reused
 * across every workspace Bridge on this machine — never synced, never in workspaceState, never a
 * committable file. Digests derived from this key are meaningless without it (the no-plaintext-on-disk
 * invariant extends to "no reversible-without-the-key" for whatever persists).
 */
export async function loadOrCreateHmacKey(host: SecretPort): Promise<Buffer> {
  const existing = await host.getSecret(HMAC_KEY_SECRET_ID);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, "hex");
  const key = crypto.randomBytes(32);
  await host.setSecret(HMAC_KEY_SECRET_ID, key.toString("hex"));
  return key;
}

export type CallerKind = "agent" | "master" | "legacy" | "external" | "human";

/** Immutable — resolved exactly once at auth time; an in-flight request keeps its snapshot even if the
 *  underlying token is invalidated mid-request (dueto F4). */
export interface CallerSnapshot {
  readonly kind: CallerKind;
  /** set only for kind "agent" — the resolved agent name. */
  readonly name?: string;
}

export type RegistryFailureReason = "token_unknown" | "token_expired" | "token_workspace_mismatch" | "token_revoked";

export type ResolveResult = { ok: true; snapshot: CallerSnapshot } | { ok: false; reason: RegistryFailureReason };

/** workspace + bridge-instance scoping (dueto F10) — every mint/resolve call is scoped by this pair. */
export interface CallerScope {
  workspaceId: string;
  instanceId: string;
}

export interface MintOptions extends CallerScope {
  /** idle-orphan TTL in ms (sliding — refreshed on every successful resolve). Default 12h. */
  ttlMs?: number;
  /** test seam — defaults to Date.now(). */
  now?: number;
}

export interface ResolveOptions extends CallerScope {
  now?: number;
}

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 12;

interface RegistryEntry {
  digest: Buffer;
  name: string;
  workspaceId: string;
  instanceId: string;
  state: "live" | "revoked";
  mintedAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** A digest-hex-only shape safe to persist (e.g. workspaceState) — never the plaintext token. */
export interface PersistableEntry {
  digestHex: string;
  name: string;
  workspaceId: string;
  instanceId: string;
  state: "live" | "revoked";
  mintedAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

/** Constant-time buffer compare guarding against length-based short-circuit (both are fixed 32-byte
 *  HMAC-SHA256 digests in practice, but this stays correct if that ever changes). */
function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class CallerIdentityRegistry {
  private entries: RegistryEntry[] = [];

  /**
   * spec 351 T6 (resume env proof) — `initial` reloads a digest-only snapshot from workspaceState so a
   * tmux session that SURVIVES an extension-host reload (Tachyon's core "sessions outlive the editor"
   * promise) doesn't get permanently stranded on a token a brand-new empty registry has never heard of.
   * Safe because the reload uses the SAME machine-local HMAC key (SecretStorage) and the SAME persisted
   * workspace+instance scope (see Workspace.ts) — a digest computed the same way always matches.
   */
  constructor(
    private readonly hmacKey: Buffer,
    initial: PersistableEntry[] = [],
  ) {
    this.entries = initial.map((e) => ({
      digest: Buffer.from(e.digestHex, "hex"),
      name: e.name,
      workspaceId: e.workspaceId,
      instanceId: e.instanceId,
      state: e.state,
      mintedAt: e.mintedAt,
      lastSeenAt: e.lastSeenAt,
      expiresAt: e.expiresAt,
    }));
  }

  private digestOf(token: string): Buffer {
    return crypto.createHmac("sha256", this.hmacKey).update(token).digest();
  }

  /** Mints a fresh per-agent token, revoking any prior LIVE entry for the same name+scope first (restart =
   *  revoke-old-then-mint-new, dueto F4 ordering). Returns the plaintext token ONCE — never stored. */
  mint(name: string, opts: MintOptions): string {
    const now = opts.now ?? Date.now();
    this.revoke(name, opts, now);
    const token = crypto.randomBytes(32).toString("hex");
    this.entries.push({
      digest: this.digestOf(token),
      name,
      workspaceId: opts.workspaceId,
      instanceId: opts.instanceId,
      state: "live",
      mintedAt: now,
      lastSeenAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    });
    return token;
  }

  /** Revokes the current LIVE entry for name+scope, if any (kill/dismiss/restart). No-op if not live. */
  revoke(name: string, scope: CallerScope, now = Date.now()): void {
    for (const e of this.entries) {
      if (e.state === "live" && e.name === name && e.workspaceId === scope.workspaceId && e.instanceId === scope.instanceId) {
        e.state = "revoked";
        e.lastSeenAt = now;
      }
    }
  }

  /** True when `name` currently has a LIVE, unexpired token in this scope — the legacy-allowlist guard
   *  uses this to tell "a real running agent" from "a made-up string a test/legacy caller passed". */
  isLive(name: string, scope: CallerScope, now = Date.now()): boolean {
    return this.entries.some(
      (e) => e.state === "live" && e.name === name && e.workspaceId === scope.workspaceId && e.instanceId === scope.instanceId && e.expiresAt > now,
    );
  }

  /**
   * Hash the presented bearer once, then constant-time-compare against every entry's digest (dueto F2 —
   * indistinguishable timing/messages for an unknown token). Security-ordered like completeNode's
   * validator: existence (any scope) → scope match → revoked → expired, so a caller never learns more
   * than the one reason that actually applies. A successful resolve slides the idle TTL forward.
   */
  resolve(bearer: string, opts: ResolveOptions): ResolveResult {
    const digest = this.digestOf(bearer);
    const now = opts.now ?? Date.now();
    let anyScope: RegistryEntry | undefined;
    let inScope: RegistryEntry | undefined;
    for (const e of this.entries) {
      if (!timingSafeEqualBuf(digest, e.digest)) continue;
      anyScope = e;
      if (e.workspaceId === opts.workspaceId && e.instanceId === opts.instanceId) inScope = e;
    }
    if (!anyScope) return { ok: false, reason: "token_unknown" };
    if (!inScope) return { ok: false, reason: "token_workspace_mismatch" };
    if (inScope.state === "revoked") return { ok: false, reason: "token_revoked" };
    if (inScope.expiresAt <= now) return { ok: false, reason: "token_expired" };
    inScope.lastSeenAt = now;
    inScope.expiresAt = now + DEFAULT_TTL_MS;
    return { ok: true, snapshot: { kind: "agent", name: inScope.name } };
  }

  /** Garbage-collects entries past their idle deadline (bounded memory — a housekeeping pass, not a
   *  correctness dependency: resolve() already checks expiresAt on its own). Returns the count removed. */
  sweepOrphans(now = Date.now()): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.expiresAt > now);
    return before - this.entries.length;
  }

  /** Digest-only, hex-encoded persistable snapshot — proves the no-plaintext-on-disk invariant: nothing
   *  here can be turned back into a bearer token without the HMAC key. */
  toPersistable(): PersistableEntry[] {
    return this.entries.map((e) => ({
      digestHex: e.digest.toString("hex"),
      name: e.name,
      workspaceId: e.workspaceId,
      instanceId: e.instanceId,
      state: e.state,
      mintedAt: e.mintedAt,
      lastSeenAt: e.lastSeenAt,
      expiresAt: e.expiresAt,
    }));
  }
}

export type CallerResolveFailureReason = RegistryFailureReason | "legacy_unvalidated";

export type CallerResolveResult = { ok: true; snapshot: CallerSnapshot } | { ok: false; reason: CallerResolveFailureReason };

export interface ResolveCallerInput {
  /** the raw bearer value (already stripped of "Bearer "); undefined when no Authorization header at all. */
  bearer: string | undefined;
  registry: CallerIdentityRegistry | undefined;
  scope: CallerScope;
  /** the workspace's shared master token; undefined disables Bearer auth entirely (settings.auth: false) —
   *  callers of this function should only be reached when auth is ON (Bridge.ts keeps its own bypass). */
  masterToken: string;
  /** the workspace's dedicated external-client token; distinct from the shared/legacy master token. */
  externalToken?: string;
  /** settings.legacyBridgeAuth — default ON for existing workspaces (dueto F1). */
  legacyCompatEnabled: boolean;
  now?: number;
}

/**
 * Bridge.ts's auth block, factored out for testability. Per-agent registry match takes priority (an agent
 * token always resolves as itself, regardless of the compat setting); otherwise a bearer equal to the
 * workspace's shared token resolves as `legacy` (compat ON — the pre-351 shared-token behavior, kept
 * indistinguishable from today so existing bridge tests pass unchanged) or is rejected with
 * `legacy_unvalidated` (compat OFF — new workspaces don't accept the shared token for agent traffic at
 * all). Neither path can ever equal `master`/`human` here (dueto F5): those are reserved for
 * a deliberate human "Copy Bridge Token" external-tool flow and an internal host-only call path,
 * respectively — this function only ever produces agent/legacy/external-shaped results from an HTTP Bearer.
 */
export function resolveCaller(input: ResolveCallerInput): CallerResolveResult {
  if (!input.bearer) return { ok: false, reason: "token_unknown" };
  if (input.registry) {
    const agentResult = input.registry.resolve(input.bearer, { ...input.scope, now: input.now });
    if (agentResult.ok) return agentResult;
    if (agentResult.reason !== "token_unknown") return agentResult; // a KNOWN agent token, just not valid right now
  }
  if (input.externalToken && tokenMatchesConstantTime(input.bearer, input.externalToken)) {
    return { ok: true, snapshot: { kind: "external" } };
  }
  if (tokenMatchesConstantTime(input.bearer, input.masterToken)) {
    return input.legacyCompatEnabled ? { ok: true, snapshot: { kind: "legacy" } } : { ok: false, reason: "legacy_unvalidated" };
  }
  return { ok: false, reason: "token_unknown" };
}

/** Same hash-then-compare shape as token.ts's tokenMatches (kept local to avoid a bridge/token.js import
 *  cycle risk); used only for the master/legacy shared-token comparison. */
function tokenMatchesConstantTime(received: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(received).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export type ActorMismatchReason = "caller_mismatch" | "master_claim_denied";

export type ActorResolution = { ok: true; name: string | undefined } | { ok: false; reason: ActorMismatchReason; message: string };

export interface ResolveActorOptions {
  caller: CallerSnapshot;
  /** the tool param's declared value (e.g. spawn_agent's `parent`, notify_agent's `agent`); undefined = omitted. */
  declared: string | undefined;
  registry: CallerIdentityRegistry | undefined;
  scope: CallerScope;
  /** compat allowlist of agent names a legacy caller MAY claim (dueto F1's documented retirement hook).
   *  Ships EMPTY per the plan's resolved open question. */
  legacyAllowlist?: readonly string[];
}

/**
 * The actor-vs-subject helper (dueto F6): resolves what an ACTOR self-identifying param should be.
 * - omitted declared → the resolved caller (or undefined for external/human, who have no agent name)
 * - kind "agent": declared === caller.name → ok; anything else → `caller_mismatch` naming both
 * - kind "external"/"human"/"master": ANY declared identity claim is denied (`master_claim_denied`) — no
 *   allowlist, ever (dueto F5: master/human can never claim an agent identity)
 * - kind "legacy": bypasses verbatim UNLESS the declared name is a currently-LIVE agent identity off the
 *   (empty) allowlist — that specific case is the t-d7b3a9 spoof this spec closes; everything else (the
 *   existing bridge test suite's made-up param strings) passes through unchanged (parity, dueto F1).
 */
export function resolveActor(opts: ResolveActorOptions): ActorResolution {
  const { caller, declared } = opts;
  if (caller.kind === "agent") {
    if (declared === undefined || declared === caller.name) return { ok: true, name: caller.name };
    return {
      ok: false,
      reason: "caller_mismatch",
      message: `caller_mismatch: resolved caller is '${caller.name}' but the call declared '${declared}'`,
    };
  }
  if (caller.kind === "external" || caller.kind === "human" || caller.kind === "master") {
    if (declared === undefined) return { ok: true, name: undefined };
    return {
      ok: false,
      reason: "master_claim_denied",
      message: `master_claim_denied: a ${caller.kind} caller cannot claim agent identity '${declared}'`,
    };
  }
  // kind "legacy"
  if (declared === undefined) return { ok: true, name: undefined };
  const allowlist = opts.legacyAllowlist ?? [];
  if (allowlist.includes(declared)) return { ok: true, name: declared };
  if (opts.registry?.isLive(declared, opts.scope)) {
    return {
      ok: false,
      reason: "caller_mismatch",
      message: `caller_mismatch: '${declared}' is a live agent identity and cannot be claimed by a legacy-token caller`,
    };
  }
  return { ok: true, name: declared }; // verbatim passthrough — bridge test parity
}
