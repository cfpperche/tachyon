/**
 * t-50bbd4 — the host implementation of the formation lifecycle port.
 *
 * This is the half that was missing: SDD 427 built the lanes, SDD 429 built lifecycle/Studio, and
 * nothing ever constructed the authority a spawn needs to read one. The port (`lifecycleConsumer.ts`)
 * is the socket; this is the plug.
 *
 * NO NEW KEY, NO NEW VAULT, NO NEW FILE. The suppression key is DERIVED from the machine-local HMAC
 * key that `loadOrCreateHmacKey` already custodies in VS Code SecretStorage — the same key the caller
 * registry and authority heads use. Derivation is domain-separated, so the suppression capability
 * cannot be confused with, or substituted for, any other use of that key: a receipt MAC and a caller
 * digest are computed under different subkeys even though one secret backs both. Rotation therefore
 * follows the host key for free, with nothing extra to remember.
 *
 * FAIL-CLOSED, deliberately harder than the surrounding code. `Workspace` degrades to a shared token
 * with a warning when SecretStorage is unavailable, because a Bridge without per-agent tokens is
 * still a working Bridge. Formation is not like that: without the key there is no way to attest that
 * the runtime suppressed its native lanes, and rendering a Soul on an unattested path could hand the
 * agent two identities with neither side knowing. So no key means NO PORT — the lifecycle simply sees
 * no formation, which reads as "this agent has no profile Soul" rather than as a silent downgrade.
 */

import crypto from "node:crypto";
import path from "node:path";
import { FormationAuthorityStore } from "./authorityStore.js";
import { HumanLaneSuppressionAuthority, resolveHumanFormationPayload } from "./humanLanes.js";
import type { FormationLifecyclePort, FormationSoulOutcome } from "./lifecycleConsumer.js";

/**
 * Domain separator. Changing this string invalidates every receipt derived under the old one, which
 * is the intended blast radius: it is a capability namespace, not a version number to bump casually.
 */
const SUPPRESSION_KEY_INFO = "tachyon/formation/native-suppression/v1";

/**
 * Derive the suppression subkey from the host's machine-local HMAC key.
 *
 * HMAC-as-KDF rather than raw reuse: handing the same bytes to two different MACs lets a value minted
 * for one purpose be presented as the other. The domain string is what makes a suppression receipt
 * unusable as a caller digest and vice versa.
 */
export function deriveSuppressionKey(hostKey: Buffer): Buffer {
  if (hostKey.length < 32) throw new Error("formation suppression key derivation requires a 32-byte host key");
  return crypto.createHmac("sha256", hostKey).update(SUPPRESSION_KEY_INFO).digest();
}

export interface FormationLifecycleHostInput {
  /** The machine-local key `loadOrCreateHmacKey` custodies. Absent ⇒ no port (fail-closed). */
  hostKey: Buffer | undefined;
  /** The workspace's existing private host root; no new directory is introduced. */
  hostRoot: string;
  workspaceId: string;
  workspaceRoot: string;
  /** Resolves the adapter Tachyon will actually launch, so a receipt cannot claim a different one. */
  runtimeAdapterOf: (agentName: string) => string | undefined;
  /** Resolves the agentId for a declared agent name; absent ⇒ not a canonical profile agent. */
  agentIdOf: (agentName: string) => string | undefined;
  /**
   * Whether the runtime's NATIVE lane delivery is confirmed suppressed for this adapter.
   *
   * The receipt attests exactly this, so the host must not issue one on hope. A runtime with no
   * measured suppression returns false and the lane refuses — which is the honest outcome, because
   * the alternative is Tachyon's Soul and the runtime's own memory both reaching the agent.
   */
  nativeSuppressionConfirmed: (adapter: string) => boolean;
  runtimeTrustClassOf: (adapter: string) => string;
  now?: () => string;
}

/**
 * Build the port, or return undefined when the host cannot back it.
 *
 * Undefined is not a degraded mode — it is the absence of the capability, which `AgentManager` already
 * treats as "no formation", i.e. exactly what a non-canonical agent looks like.
 */
export function createFormationLifecycleHost(input: FormationLifecycleHostInput): FormationLifecyclePort | undefined {
  if (!input.hostKey || input.hostKey.length < 32) return undefined;
  const suppressionKey = deriveSuppressionKey(input.hostKey);
  const now = input.now ?? (() => new Date().toISOString());
  const suppression = new HumanLaneSuppressionAuthority(suppressionKey, now);

  const store = new FormationAuthorityStore(path.join(input.hostRoot, "formation"), {
    now,
    // Reading a Soul at spawn is not a mutation and never revokes or reads a selector, so those
    // policies stay closed here. A read path that could mutate would be a wider capability than the
    // caller asked for, and this port only ever answers one question.
    authorizeLaunch: () => true,
    // Required by the store, and deliberately a throw: this port only ever calls `currentVector`,
    // which is a read. `resolvePayload` belongs to the snapshot/commit path, so reaching it from here
    // would mean a read had grown into a publication — better to fail loudly than to quietly satisfy
    // a capability this host never meant to offer.
    resolvePayload: () => {
      throw new Error("formation lifecycle host is read-only: payload publication is not available on the spawn path");
    },
    authorizeMutation: () => false,
    authorizeSelectorRevocation: () => false,
    authorizeSelectorRead: () => false,
    verifyNativeSuppression: ({ evidence, vector, operationId, runtimeTrustClass, verifiedAt }) =>
      suppression.verify(evidence, vector, runtimeTrustClass, operationId, verifiedAt),
  });

  return {
    async resolveSoul({ agentName, operationId }): Promise<FormationSoulOutcome> {
      const agentId = input.agentIdOf(agentName);
      if (!agentId) return { state: "absent" };
      const vector = store.currentVector(agentId);
      if (!vector) return { state: "absent" };
      if (vector.profile.lanes.soul.mode !== "profile") return { state: "lane-disabled" };

      const adapter = input.runtimeAdapterOf(agentName);
      if (!adapter) return { state: "refused", reason: "runtime adapter for this agent could not be resolved" };
      if (adapter !== vector.profile.runtimeInspector.adapter) {
        // The vector was authored against a different runtime. Rendering it anyway would attest a
        // suppression that never happened for the runtime actually launching.
        return { state: "refused", reason: `profile authority names runtime '${vector.profile.runtimeInspector.adapter}', launch uses '${adapter}'` };
      }
      if (!input.nativeSuppressionConfirmed(adapter)) {
        return { state: "refused", reason: `native lane delivery is not confirmed suppressed for runtime '${adapter}'` };
      }

      const runtimeTrustClass = input.runtimeTrustClassOf(adapter);
      try {
        // The receipt must cover EVERY enabled lane exactly once — the authority enforces that, and
        // deriving the list from the vector rather than hardcoding it is what keeps a newly enabled
        // lane from silently rendering without attestation.
        const lanes = (["soul", "instructions", "evolution", "memory"] as const)
          .filter((lane) => vector.profile.lanes[lane].mode === "profile");
        const receipt = suppression.issueAfterSuppression({
          operationId,
          vector,
          runtimeAdapter: adapter,
          runtimeTrustClass,
          lanes,
          issuedAt: now(),
        });
        const payload = await resolveHumanFormationPayload({
          operationId,
          workspaceRoot: input.workspaceRoot,
          vector,
          bridgeGuidance: false,
          runtimeTrustClass,
          suppressionAuthority: suppression,
          suppressionReceipt: receipt,
        });
        if (!payload.soul) return { state: "lane-disabled" };
        return { state: "resolved", soul: payload.soul };
      } catch (err) {
        // Every lane failure — CAS mismatch, retired generation, renderer drift, bad receipt — arrives
        // here as a refusal with its reason. None of them fall back to a different Soul.
        return { state: "refused", reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
