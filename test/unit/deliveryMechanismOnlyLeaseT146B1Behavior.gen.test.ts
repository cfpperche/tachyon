import { describe, expect, it } from "vitest";
import { DeliveryLeaseError, DeliveryLeaseService } from "../../src/delivery/leaseService.js";

describe("T14.6B1 mechanism-only lease policy", () => {
  it("disabled refuses acquire before probing the fence", async () => {
    let probed = false;
    const lease = new DeliveryLeaseService({ handoffSafety: "disabled", store: { getOperationResult: async () => undefined } as never,
      processFence: { capability: () => { probed = true; return { supported: true, domain: "test" }; }, freeze: async () => undefined, terminate: async () => undefined, proveEmpty: async () => ({ state: "proven_empty" }) },
      canonicalWorktreeFor: () => "/unused", readHead: () => "a", inspectWorktree: () => ({ headSha: "a", clean: true }), isAncestor: () => true, withWorktreeLock: async (_path, fn) => fn() });
    await expect(lease.acquire({ deliveryId: "d", expectedHeadSha: "a", canonicalWorktree: "/unused", role: "implementer", executionAgent: "worker", grantedBy: { kind: "system" }, ownsSubset: [], operationId: "acquire" }))
      .rejects.toMatchObject({ code: "DELIVERY_LEASE_UNAVAILABLE" } satisfies Partial<DeliveryLeaseError>);
    expect(probed).toBe(false);
  });
});
