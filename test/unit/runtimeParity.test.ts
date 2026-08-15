import { describe, expect, it } from "vitest";
import { PROBE_RUNTIME_SCHEMA } from "@tachyon/bridge/tools/fleet-probes.js";
import { headlessProbeAdapters } from "@tachyon/engine/probe/adapters/registry.js";
import {
  PARITY_DIMENSIONS,
  PARITY_RUNTIMES,
  RUNTIME_PARITY,
  parityDeclarationErrors,
  runtimeUsesSilentPersistenceHooks,
  type ParityCell,
} from "@tachyon/engine/runtime/parity.js";

function declaredWired(cell: ParityCell): boolean {
  return cell.verdict === "wired";
}

describe("SDD 508 runtime parity declaration", () => {
  it("has every runtime × dimension cell and valid evidence metadata", () => {
    expect(parityDeclarationErrors(RUNTIME_PARITY)).toEqual([]);
  });

  it("refuses a missing cell", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    delete malformed["session-hooks"]!.grok;
    expect(parityDeclarationErrors(malformed)).toContain("session-hooks/grok: missing parity cell");
  });

  it("refuses cannot without a written reason", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    malformed["session-hooks"]!.grok = { verdict: "cannot" };
    expect(parityDeclarationErrors(malformed)).toContain("session-hooks/grok: cannot requires a written reason");
  });

  it("refuses measured without runtime version and date", () => {
    const malformed = structuredClone(RUNTIME_PARITY) as unknown as Record<string, Record<string, unknown>>;
    malformed["session-hooks"]!.grok = { verdict: "measured" };
    expect(parityDeclarationErrors(malformed)).toEqual(expect.arrayContaining([
      "session-hooks/grok: measured requires runtimeVersion",
      "session-hooks/grok: measured requires measuredAt as YYYY-MM-DD",
    ]));
  });

  it("derives session-hooks through the runtime decision called by Workspace.silentPersistenceHooksDesired", () => {
    for (const runtime of PARITY_RUNTIMES) {
      const product = runtimeUsesSilentPersistenceHooks(runtime);
      const declared = declaredWired(RUNTIME_PARITY["session-hooks"][runtime]);
      expect(product, `session-hooks/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("derives headless-probe through the adapter registry used by Workspace", () => {
    const adapters = headlessProbeAdapters();
    for (const runtime of PARITY_RUNTIMES) {
      const product = adapters.has(runtime) && PROBE_RUNTIME_SCHEMA.safeParse(runtime).success;
      const declared = declaredWired(RUNTIME_PARITY["headless-probe"][runtime]);
      expect(product, `headless-probe/${runtime}: product=${product ? "wired" : "not-wired"}, declaration=${declared ? "wired" : "not-wired"}`).toBe(declared);
    }
  });

  it("keeps the declaration axes closed to the scoped runtimes and implemented dimensions", () => {
    expect(Object.keys(RUNTIME_PARITY)).toEqual([...PARITY_DIMENSIONS]);
    for (const dimension of PARITY_DIMENSIONS) {
      expect(Object.keys(RUNTIME_PARITY[dimension])).toEqual([...PARITY_RUNTIMES]);
    }
  });
});
