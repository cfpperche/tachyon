import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { CallerIdentityRegistry, resolveCaller, resolveActor, loadOrCreateHmacKey, type CallerScope, type SecretPort } from "../../src/bridge/callerIdentity.js";

/**
 * spec 351 (layer B, T1) — the digest-only registry + resolution + actor helper, in isolation from
 * Bridge.ts/tools.ts wiring (those get their own integration tests in T3/T4).
 */

const KEY = crypto.randomBytes(32);
const SCOPE_A: CallerScope = { workspaceId: "ws-a", instanceId: "inst-1" };
const SCOPE_B: CallerScope = { workspaceId: "ws-b", instanceId: "inst-1" };

describe("CallerIdentityRegistry — mint/resolve lifecycle", () => {
  it("mints a unique token per call and resolves it back to the agent", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const t1 = reg.mint("claude", SCOPE_A);
    const t2 = reg.mint("codex", SCOPE_A);
    expect(t1).not.toBe(t2);
    expect(reg.resolve(t1, SCOPE_A)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
    expect(reg.resolve(t2, SCOPE_A)).toEqual({ ok: true, snapshot: { kind: "agent", name: "codex" } });
  });

  it("an unknown token resolves token_unknown", () => {
    const reg = new CallerIdentityRegistry(KEY);
    reg.mint("claude", SCOPE_A);
    expect(reg.resolve("bogus-token-value", SCOPE_A)).toEqual({ ok: false, reason: "token_unknown" });
  });

  it("digest-only: the persistable snapshot never contains the plaintext token", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const token = reg.mint("claude", SCOPE_A);
    const persisted = reg.toPersistable();
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].digestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted[0].name).toBe("claude");
  });

  it("revoke invalidates the token with reason token_revoked (not a generic unknown)", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const token = reg.mint("claude", SCOPE_A);
    reg.revoke("claude", SCOPE_A);
    expect(reg.resolve(token, SCOPE_A)).toEqual({ ok: false, reason: "token_revoked" });
  });

  it("restart = revoke-old-then-mint-new: the old token is revoked, the new one resolves", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const oldToken = reg.mint("claude", SCOPE_A);
    const newToken = reg.mint("claude", SCOPE_A); // mint() itself revokes the prior live entry first
    expect(reg.resolve(oldToken, SCOPE_A)).toEqual({ ok: false, reason: "token_revoked" });
    expect(reg.resolve(newToken, SCOPE_A)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
  });

  it("in-flight semantics: a token resolved once stays valid for that call even if revoked immediately after — the registry itself doesn't retroactively invalidate a snapshot already taken", () => {
    // This test proves the REGISTRY's per-call behavior (resolve at time T succeeds); the "immutable
    // snapshot survives mid-request revocation" guarantee is an architectural property of Bridge.ts
    // resolving once per request and threading the snapshot by value (see bridge.test.ts / Bridge.ts).
    const reg = new CallerIdentityRegistry(KEY);
    const token = reg.mint("claude", SCOPE_A);
    const before = reg.resolve(token, SCOPE_A);
    expect(before.ok).toBe(true);
    reg.revoke("claude", SCOPE_A);
    const snapshotTakenBefore = before; // the caller already captured this — unaffected by the revoke below
    expect(snapshotTakenBefore).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
    expect(reg.resolve(token, SCOPE_A)).toEqual({ ok: false, reason: "token_revoked" });
  });

  it("TTL: an idle-past-deadline token resolves token_expired; a successful resolve slides the TTL forward", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const now = 1_000_000;
    const token = reg.mint("claude", { ...SCOPE_A, ttlMs: 1000, now });
    expect(reg.resolve(token, { ...SCOPE_A, now: now + 500 }).ok).toBe(true); // slides expiresAt to now+500+DEFAULT_TTL
    expect(reg.resolve(token, { ...SCOPE_A, now: now + 2000 }).ok).toBe(true); // still valid — TTL was refreshed above
    const reg2 = new CallerIdentityRegistry(KEY);
    const token2 = reg2.mint("claude", { ...SCOPE_A, ttlMs: 1000, now });
    // never resolved again before its original deadline — should expire
    expect(reg2.resolve(token2, { ...SCOPE_A, now: now + 5000 })).toEqual({ ok: false, reason: "token_expired" });
  });

  it("sweepOrphans garbage-collects expired entries without affecting resolve's own expiry check", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const now = 1_000_000;
    reg.mint("claude", { ...SCOPE_A, ttlMs: 100, now });
    expect(reg.sweepOrphans(now + 1000)).toBe(1);
    expect(reg.toPersistable()).toHaveLength(0);
  });

  it("reloading from a persistable snapshot (same HMAC key + scope) resolves a pre-reload token — the T6 stale-pane fix", () => {
    const reg1 = new CallerIdentityRegistry(KEY);
    const token = reg1.mint("claude", SCOPE_A);
    const snapshot = reg1.toPersistable();
    // simulate an extension-host reload: a BRAND NEW registry instance, seeded from the persisted snapshot.
    const reg2 = new CallerIdentityRegistry(KEY, snapshot);
    expect(reg2.resolve(token, SCOPE_A)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
  });

  it("reloading with a DIFFERENT HMAC key never resolves the old token (key loss = hard revoke, not a leak)", () => {
    const reg1 = new CallerIdentityRegistry(KEY);
    const token = reg1.mint("claude", SCOPE_A);
    const snapshot = reg1.toPersistable();
    const reg2 = new CallerIdentityRegistry(crypto.randomBytes(32), snapshot);
    expect(reg2.resolve(token, SCOPE_A)).toEqual({ ok: false, reason: "token_unknown" });
  });

  it("two workspaces, same agent name: workspace scoping is enforced by explicit context, not by luck", () => {
    // A single registry instance can (in principle) hold entries from multiple workspace scopes —
    // scoping must be an ENFORCED check, not an accident of separate registry instances never colliding.
    const reg = new CallerIdentityRegistry(KEY);
    const tokenInA = reg.mint("claude", SCOPE_A);
    reg.mint("claude", SCOPE_B); // same name, different workspace — a distinct token
    expect(reg.resolve(tokenInA, SCOPE_A)).toEqual({ ok: true, snapshot: { kind: "agent", name: "claude" } });
    expect(reg.resolve(tokenInA, SCOPE_B)).toEqual({ ok: false, reason: "token_workspace_mismatch" });
  });

  it("isLive reflects only currently-live, unexpired, correctly-scoped entries", () => {
    const reg = new CallerIdentityRegistry(KEY);
    reg.mint("claude", SCOPE_A);
    expect(reg.isLive("claude", SCOPE_A)).toBe(true);
    expect(reg.isLive("claude", SCOPE_B)).toBe(false);
    expect(reg.isLive("codex", SCOPE_A)).toBe(false);
    reg.revoke("claude", SCOPE_A);
    expect(reg.isLive("claude", SCOPE_A)).toBe(false);
  });
});

describe("resolveCaller — master/legacy/agent paths", () => {
  const MASTER = "a".repeat(64);

  it("an agent token always resolves as itself regardless of the compat setting", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const token = reg.mint("claude", SCOPE_A);
    for (const legacyCompatEnabled of [true, false]) {
      expect(resolveCaller({ bearer: token, registry: reg, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled })).toEqual({
        ok: true,
        snapshot: { kind: "agent", name: "claude" },
      });
    }
  });

  it("the shared master token resolves kind legacy when compat is ON", () => {
    const reg = new CallerIdentityRegistry(KEY);
    expect(resolveCaller({ bearer: MASTER, registry: reg, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled: true })).toEqual({
      ok: true,
      snapshot: { kind: "legacy" },
    });
  });

  it("the shared master token is rejected (legacy_unvalidated) when compat is OFF", () => {
    const reg = new CallerIdentityRegistry(KEY);
    expect(resolveCaller({ bearer: MASTER, registry: reg, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled: false })).toEqual({
      ok: false,
      reason: "legacy_unvalidated",
    });
  });

  it("an unknown bearer (neither agent nor master) resolves token_unknown", () => {
    const reg = new CallerIdentityRegistry(KEY);
    expect(resolveCaller({ bearer: "nope", registry: reg, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled: true })).toEqual({
      ok: false,
      reason: "token_unknown",
    });
  });

  it("a revoked agent token reports token_revoked, not token_unknown, even though the master token is also a valid bearer elsewhere", () => {
    const reg = new CallerIdentityRegistry(KEY);
    const token = reg.mint("claude", SCOPE_A);
    reg.revoke("claude", SCOPE_A);
    expect(resolveCaller({ bearer: token, registry: reg, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled: true })).toEqual({
      ok: false,
      reason: "token_revoked",
    });
  });

  it("no bearer at all resolves token_unknown", () => {
    expect(resolveCaller({ bearer: undefined, registry: undefined, scope: SCOPE_A, masterToken: MASTER, legacyCompatEnabled: true })).toEqual({
      ok: false,
      reason: "token_unknown",
    });
  });
});

describe("loadOrCreateHmacKey — SecretStorage-backed key custody", () => {
  function fakeSecretPort(): SecretPort {
    const store = new Map<string, string>();
    return {
      getSecret: (key) => Promise.resolve(store.get(key)),
      setSecret: (key, value) => {
        store.set(key, value);
        return Promise.resolve();
      },
    };
  }

  it("creates once and persists across calls (same host)", async () => {
    const host = fakeSecretPort();
    const k1 = await loadOrCreateHmacKey(host);
    const k2 = await loadOrCreateHmacKey(host);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.length).toBe(32);
  });

  it("two hosts (no shared secret store) get different keys", async () => {
    const k1 = await loadOrCreateHmacKey(fakeSecretPort());
    const k2 = await loadOrCreateHmacKey(fakeSecretPort());
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("resolveActor — actor vs subject (dueto F6)", () => {
  it("kind agent: omitted resolves to the caller; equal is ok; different is caller_mismatch naming both", () => {
    const caller = { kind: "agent" as const, name: "claude" };
    expect(resolveActor({ caller, declared: undefined, registry: undefined, scope: SCOPE_A })).toEqual({ ok: true, name: "claude" });
    expect(resolveActor({ caller, declared: "claude", registry: undefined, scope: SCOPE_A })).toEqual({ ok: true, name: "claude" });
    const mismatch = resolveActor({ caller, declared: "codex", registry: undefined, scope: SCOPE_A });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.reason).toBe("caller_mismatch");
      expect(mismatch.message).toContain("claude");
      expect(mismatch.message).toContain("codex");
    }
  });

  it("kind external/human/master: omitted is fine; ANY declared identity is master_claim_denied", () => {
    for (const kind of ["external", "human", "master"] as const) {
      const caller = { kind };
      expect(resolveActor({ caller, declared: undefined, registry: undefined, scope: SCOPE_A })).toEqual({ ok: true, name: undefined });
      const denied = resolveActor({ caller, declared: "claude", registry: undefined, scope: SCOPE_A });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toBe("master_claim_denied");
    }
  });

  it("kind legacy: bypasses verbatim for a made-up name (bridge test parity) but denies claiming a LIVE agent identity", () => {
    const reg = new CallerIdentityRegistry(KEY);
    reg.mint("claude", SCOPE_A); // "claude" is a real, currently-live agent
    const caller = { kind: "legacy" as const };
    // parity: a fabricated/test string that isn't a live agent passes through unchanged
    expect(resolveActor({ caller, declared: "reviewer", registry: reg, scope: SCOPE_A })).toEqual({ ok: true, name: "reviewer" });
    expect(resolveActor({ caller, declared: undefined, registry: reg, scope: SCOPE_A })).toEqual({ ok: true, name: undefined });
    // the t-d7b3a9 spoof: claiming a REAL live agent's identity is blocked
    const denied = resolveActor({ caller, declared: "claude", registry: reg, scope: SCOPE_A });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("caller_mismatch");
  });

  it("kind legacy: an explicit allowlist entry may claim identity even if live (documented retirement hook)", () => {
    const reg = new CallerIdentityRegistry(KEY);
    reg.mint("claude", SCOPE_A);
    const caller = { kind: "legacy" as const };
    expect(resolveActor({ caller, declared: "claude", registry: reg, scope: SCOPE_A, legacyAllowlist: ["claude"] })).toEqual({
      ok: true,
      name: "claude",
    });
  });
});
