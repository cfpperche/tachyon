import { describe, expect, it } from "vitest";
import { assessBuildProvenance, type BuildStamp, type DeployRecord } from "../../apps/vscode-extension/src/provenance/verify.js";

const cleanStamp: BuildStamp = { commit: "abc123", treeSha: "tree123", dirty: false };

function record(dist: Record<string, string>): DeployRecord {
  return {
    version: "0.55.90",
    commit: "abc123",
    treeSha: "tree123",
    workingTreeClean: true,
    packagedBy: "test",
    vsix: { path: "tachyon-0.55.90.vsix", sha256: "vsix-sha" },
    dist,
    verify: { command: "npm run verify:full", result: "passed" },
    note: "unverified-build detector fixture",
  };
}

describe("container-generated delegation behavior", () => {
  it("a build from an uncommitted tree self-reports dirty and a tampered dist fails its provenance record, while an unrecorded clean build stays silent", async () => {
    const dirty = await assessBuildProvenance({
      version: "0.55.90",
      stamp: { ...cleanStamp, dirty: true },
      record: null,
      hashDistFile: async () => "unused",
    });
    expect(dirty.map((w) => w.message).join("\n")).toMatch(/uncommitted source/);

    const matching = await assessBuildProvenance({
      version: "0.55.90",
      stamp: cleanStamp,
      record: record({ "dist/extension.js": "ok", "dist/webview/sidebar.js": "ok2" }),
      hashDistFile: async (relPath) => (relPath === "dist/extension.js" ? "ok" : "ok2"),
    });
    expect(matching).toEqual([]);

    const tampered = await assessBuildProvenance({
      version: "0.55.90",
      stamp: cleanStamp,
      record: record({ "dist/extension.js": "expected" }),
      hashDistFile: async () => "actual",
    });
    expect(tampered).toHaveLength(1);
    expect(tampered[0]?.message).toContain("dist/extension.js");

    const unrecorded = await assessBuildProvenance({
      version: "0.55.90",
      stamp: cleanStamp,
      record: null,
      hashDistFile: async () => "unused",
    });
    expect(unrecorded).toEqual([]);

    const unknownCommit = await assessBuildProvenance({
      version: "0.55.90",
      stamp: { commit: null, treeSha: null, dirty: false },
      record: null,
      hashDistFile: async () => "unused",
    });
    expect(unknownCommit.map((w) => w.message).join("\n")).toMatch(/uncommitted source/);
  });
});
