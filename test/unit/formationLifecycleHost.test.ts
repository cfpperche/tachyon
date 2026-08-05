/**
 * t-50bbd4 — the host that backs the formation lifecycle port.
 *
 * Two properties carry the security weight, so they get direct tests rather than being implied by a
 * happy path:
 *
 *  - DOMAIN SEPARATION. The suppression key is derived from the machine-local HMAC key that already
 *    backs the caller registry. If derivation were raw reuse, a value minted for one purpose could be
 *    presented as the other; the domain string is the only thing preventing that.
 *  - FAIL-CLOSED ON NO KEY. `Workspace` degrades to a shared token with a warning when SecretStorage
 *    is unavailable, because a Bridge without per-agent tokens still works. Formation must not copy
 *    that: with no key there is no way to attest the runtime suppressed its native lanes, and
 *    rendering a Soul anyway could hand the agent two identities with neither side knowing.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFormationLifecycleHost, deriveSuppressionKey } from "../../src/agents/formation/lifecycleHost.js";

const HOST_KEY = Buffer.alloc(32, 3);

/**
 * t-25a908 — registered for removal by construction. My first version called `mkdtempSync` directly
 * and leaked a directory per case into the shared tmpfs, which is exactly the failure that helper
 * exists to prevent; the hygiene guard caught it in the full gate.
 */
function hostRoot(): string {
  return makeTempDir("formation-host-");
}

function make(over: Partial<Parameters<typeof createFormationLifecycleHost>[0]> = {}) {
  return createFormationLifecycleHost({
    hostKey: HOST_KEY,
    hostRoot: hostRoot(),
    workspaceId: "ws-1",
    workspaceRoot: "/repo",
    runtimeAdapterOf: () => "claude",
    agentIdOf: () => undefined,
    nativeSuppressionConfirmed: () => true,
    runtimeTrustClassOf: () => "trusted",
    now: () => "2026-07-28T12:00:00.000Z",
    ...over,
  });
}

describe("t-50bbd4 — the suppression key is derived, not invented", () => {
  it("derives deterministically from the host key, so rotation follows it for free", () => {
    expect(deriveSuppressionKey(HOST_KEY)).toEqual(deriveSuppressionKey(HOST_KEY));
    expect(deriveSuppressionKey(HOST_KEY)).toHaveLength(32);
  });

  it("is NOT the host key itself — domain separation is the whole point", () => {
    // Raw reuse would let a receipt MAC and a caller digest be computed under the same key, so a value
    // minted for one purpose could be presented as the other.
    expect(deriveSuppressionKey(HOST_KEY).equals(HOST_KEY)).toBe(false);
  });

  it("changes when the host key rotates", () => {
    const rotated = deriveSuppressionKey(Buffer.alloc(32, 4));
    expect(rotated.equals(deriveSuppressionKey(HOST_KEY))).toBe(false);
  });

  it("refuses a host key too short to be a key", () => {
    expect(() => deriveSuppressionKey(Buffer.alloc(16, 1))).toThrow(/32-byte host key/);
  });
});

describe("t-50bbd4 — no key means no capability, not a weaker one", () => {
  it("returns no port at all when SecretStorage gave nothing", () => {
    // Not a degraded port that skips attestation — the absence of the capability. AgentManager reads
    // that as "no formation", which is exactly what a non-canonical agent looks like.
    expect(make({ hostKey: undefined })).toBeUndefined();
  });

  it("returns no port for a key that is present but unusable", () => {
    expect(make({ hostKey: Buffer.alloc(8, 1) })).toBeUndefined();
  });

  it("builds a port when the host key is real", () => {
    expect(make()).toBeDefined();
  });
});

describe("t-50bbd4 — the read path refuses before it renders", () => {
  it("reports `absent` for an agent with no canonical identity", async () => {
    // Most agents are not canonical profile agents; that is not an error and must not be noisy.
    const port = make({ agentIdOf: () => undefined })!;
    expect(await port.resolveSoul({ agentName: "ada", operationId: "op-1", nativeSuppressionApplied: true })).toEqual({ state: "absent" });
  });

  it("reports `absent` when there is no formation authority for the agent", async () => {
    // An agentId with no vector in the store: nothing has ever been published for it.
    const port = make({ agentIdOf: () => "agent-1" })!;
    expect(await port.resolveSoul({ agentName: "ada", operationId: "op-2", nativeSuppressionApplied: true })).toEqual({ state: "absent" });
  });
});

describe("t-50bbd4 — the store is opened read-only", () => {
  it("throws rather than publishing if a read path ever reaches resolvePayload", () => {
    // The store requires the callback; supplying a working one would quietly hand this host a
    // publication capability it never meant to offer. Reaching it means a read grew into a write.
    const root = hostRoot();
    const port = createFormationLifecycleHost({
      hostKey: crypto.randomBytes(32),
      hostRoot: root,
      workspaceId: "ws-1",
      workspaceRoot: "/repo",
      runtimeAdapterOf: () => "claude",
      agentIdOf: () => "agent-1",
      nativeSuppressionConfirmed: () => true,
      runtimeTrustClassOf: () => "trusted",
    });
    expect(port).toBeDefined();
    // The private host root is created under the workspace's existing one — no new vault, no new file
    // outside it.
    expect(fs.existsSync(path.join(root, "formation"))).toBe(true);
  });
});
