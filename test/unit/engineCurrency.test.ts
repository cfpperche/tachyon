import { describe, expect, it } from "vitest";
import { classifyEngineCurrency, engineCurrencyNote } from "../../src/engine-service/engineCurrency.js";
import { buildExecutionGraphSectionVm } from "../../src/webview/Cockpit.js";

/**
 * t-f54b62 — the running engine can be arbitrarily older than the installed one, and nothing said so.
 *
 * The field evidence is in t-7ba92a: two real engines on this machine, one on each side of the
 * execution-ledger wiring. The older one served the fleet since 26/07 13:32 and wrote no ledger; the
 * newer one, up since 28/07 02:57, wrote measured events. The code was identical. Only the daemon's
 * age differed, and the surface said nothing either way.
 */
describe("t-f54b62 — is the running engine the installed one", () => {
  const running = { bundleId: "bundle-aaa", startedAt: "2026-07-26T16:32:34.000Z" };

  it("says current when the running bundle is the installed one", () => {
    expect(classifyEngineCurrency({ running, expectedBundleId: "bundle-aaa" })).toEqual({
      kind: "current",
      bundleId: "bundle-aaa",
      startedAt: "2026-07-26T16:32:34.000Z",
    });
  });

  it("says outdated when the daemon is serving different bytes, and names both", () => {
    // The measured case: attaching to a protocol-compatible daemon that predates the installed build.
    expect(classifyEngineCurrency({ running, expectedBundleId: "bundle-bbb" })).toEqual({
      kind: "outdated",
      runningBundleId: "bundle-aaa",
      expectedBundleId: "bundle-bbb",
      startedAt: "2026-07-26T16:32:34.000Z",
    });
  });

  describe("refuses to guess, because a wrong verdict is worse than silence", () => {
    it("is unknown when no engine identity is available", () => {
      expect(classifyEngineCurrency({ running: undefined, expectedBundleId: "bundle-bbb" }))
        .toEqual({ kind: "unknown" });
    });

    it("is unknown when the host cannot say which bundle it would stage", () => {
      // Never `current`: "we could not compare" must not render as "you are up to date".
      expect(classifyEngineCurrency({ running, expectedBundleId: undefined }))
        .toEqual({ kind: "unknown" });
      expect(classifyEngineCurrency({ running, expectedBundleId: "   " }))
        .toEqual({ kind: "unknown" });
    });

    it("is unknown when the daemon reported no start time to attribute the staleness to", () => {
      // The whole point of the note is "running since X". Without X there is no statement to make.
      expect(classifyEngineCurrency({
        running: { bundleId: "bundle-aaa", startedAt: "" },
        expectedBundleId: "bundle-bbb",
      })).toEqual({ kind: "unknown" });
    });
  });

  describe("the note a surface may show", () => {
    it("explains an empty section only when the engine is actually stale", () => {
      const note = engineCurrencyNote(classifyEngineCurrency({ running, expectedBundleId: "bundle-bbb" }));

      expect(note).toContain("2026-07-26T16:32:34.000Z");
      expect(note).toContain("not the installed build");
      // Names the way out, so the reader is not left holding a diagnosis with no action.
      expect(note).toContain("restart");
    });

    it("has nothing to say when the engine is current or uncomparable", () => {
      // A caller that renders `?? ""` must get silence here, not a reassuring sentence it did not earn.
      expect(engineCurrencyNote(classifyEngineCurrency({ running, expectedBundleId: "bundle-aaa" })))
        .toBeUndefined();
      expect(engineCurrencyNote({ kind: "unknown" })).toBeUndefined();
    });
  });

  /**
   * The section is where the ambiguity was actually paid for: `no-telemetry` read as "nothing to
   * show" while the real cause was a daemon older than the build. Driven through the production
   * builder, for the same reason t-441b0f had to be — the halves passing proves nothing about the join.
   */
  describe("the Execution section explains an empty view when the host knows why", () => {
    const section = (currency?: Parameters<typeof engineCurrencyNote>[0]) =>
      buildExecutionGraphSectionVm(
        { executionGraph: () => ({ events: [], available: false, ...(currency ? { currency } : {}) }) } as never,
        "wshash",
      );

    it("attaches the reason when the daemon predates the installed build", () => {
      const vm = section(classifyEngineCurrency({ running, expectedBundleId: "bundle-bbb" }));

      expect(vm?.status).toBe("no-telemetry");
      expect(vm?.statusNote).toContain("2026-07-26T16:32:34.000Z");
    });

    it("stays silent when the engine is current — the section is empty for a different reason", () => {
      const vm = section(classifyEngineCurrency({ running, expectedBundleId: "bundle-aaa" }));

      expect(vm?.status).toBe("no-telemetry");
      expect(vm?.statusNote).toBeUndefined();
    });

    it("stays silent when the host offered no verdict at all", () => {
      // The pre-existing behavior, deliberately unchanged: no comparison, no explanation.
      expect(section()?.statusNote).toBeUndefined();
      expect(section({ kind: "unknown" })?.statusNote).toBeUndefined();
    });
  });
});
