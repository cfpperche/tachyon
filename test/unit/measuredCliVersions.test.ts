import { describe, expect, it } from "vitest";
import {
  compareMeasuredCliVersion,
  measuredCliVersion,
  MEASURED_CLI_VERSIONS,
  normalizeCliVersion,
} from "../../src/runtime/measuredCliVersions.js";

describe("measuredCliVersions (t-1322b5)", () => {
  it("owns a single Codex baseline taken from existing product evidence", () => {
    expect(measuredCliVersion("codex")).toBe("0.146.0");
    expect(MEASURED_CLI_VERSIONS.codex).toBe("0.146.0");
    expect(measuredCliVersion("claude")).toBeUndefined();
  });

  it("normalizes CLI banners to trailing semver", () => {
    expect(normalizeCliVersion("codex-cli 0.146.1")).toBe("0.146.1");
    expect(normalizeCliVersion("  0.146.0  ")).toBe("0.146.0");
    expect(normalizeCliVersion("not a version")).toBeUndefined();
    expect(normalizeCliVersion("")).toBeUndefined();
  });

  it("match: running equals measured", () => {
    expect(compareMeasuredCliVersion("codex", "codex-cli 0.146.0")).toEqual({
      state: "match",
      measured: "0.146.0",
      running: "0.146.0",
    });
  });

  it("drift: any patch/minor/major difference appears", () => {
    expect(compareMeasuredCliVersion("codex", "codex-cli 0.146.1")).toEqual({
      state: "drift",
      measured: "0.146.0",
      running: "0.146.1",
    });
    expect(compareMeasuredCliVersion("codex", "0.147.0")?.state).toBe("drift");
    expect(compareMeasuredCliVersion("codex", "1.0.0")?.state).toBe("drift");
  });

  it("unknown-running: null, empty, or unparseable — never assume match", () => {
    expect(compareMeasuredCliVersion("codex", null)).toEqual({
      state: "unknown-running",
      measured: "0.146.0",
    });
    expect(compareMeasuredCliVersion("codex", undefined)).toEqual({
      state: "unknown-running",
      measured: "0.146.0",
    });
    expect(compareMeasuredCliVersion("codex", "")).toEqual({
      state: "unknown-running",
      measured: "0.146.0",
    });
    expect(compareMeasuredCliVersion("codex", "codex missing")).toEqual({
      state: "unknown-running",
      measured: "0.146.0",
    });
  });

  it("runtimes without a measured constant produce no parity row", () => {
    expect(compareMeasuredCliVersion("claude", "2.1.220")).toBeUndefined();
    expect(compareMeasuredCliVersion("unknown-runtime", "1.0.0")).toBeUndefined();
  });
});
