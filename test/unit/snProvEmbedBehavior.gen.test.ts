import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessBuildProvenance, type BuildStamp } from "../../apps/vscode-extension/src/provenance/verify.js";
import { embeddedProvenancePath, readEmbeddedProvenanceRecord, type ReadFile } from "../../apps/vscode-extension/src/provenance/record.js";

const cleanStamp: BuildStamp = { commit: "abc123", treeSha: "tree123", dirty: false };

const EXTENSION_ROOT = "/opt/installed/tachyon-ext";
const embeddedRecordJson = (dist: Record<string, string>) =>
  JSON.stringify({ version: "0.55.91", engineChannel: "stable", commit: "abc123", treeSha: "tree123", workingTreeClean: true, dist });

/** A fake fs keyed by exact absolute path — only ever serves the extension-root file, never anything workspace-shaped. */
function fakeFsServing(exactPath: string, content: string): ReadFile {
  return async (absPath: string) => (absPath === exactPath ? content : null);
}

/** Mirrors checkTachyonBuildProvenance's core (sans vscode): read once from extensionRoot, assess once. A
 *  `workspaceRoot` is accepted only to prove it is never consulted — the real signature doesn't even have one. */
async function runCheck(extensionRoot: string, workspaceRootIgnoredForProof: string | undefined, readFile: ReadFile, hashes: Record<string, string>) {
  const record = await readEmbeddedProvenanceRecord(extensionRoot, readFile);
  void workspaceRootIgnoredForProof; // never threaded into the read above — that's the point being proven
  return assessBuildProvenance({
    version: "0.55.91",
    stamp: cleanStamp,
    record,
    hashDistFile: async (relPath) => hashes[relPath] ?? null,
  });
}

describe("container-generated delegation behavior", () => {
  it("build provenance is read from the extension's own embedded record, matching in any workspace and staying silent when absent", async () => {
    const recordPath = embeddedProvenancePath(EXTENSION_ROOT);
    expect(recordPath).toBe(path.join(EXTENSION_ROOT, "provenance.json"));

    // (a) matching dist hashes → no warning, and the resolver only ever answers for the extension root.
    const dist = { "dist/extension.js": "hash-a", "dist/webview/sidebar.js": "hash-b" };
    const goodReader = fakeFsServing(recordPath, embeddedRecordJson(dist));
    const matching = await runCheck(EXTENSION_ROOT, "/home/user/some-unrelated-project", goodReader, dist);
    expect(matching).toEqual([]);
    // Same reader, asked about a workspace-shaped path instead of the extension root → nothing to find.
    const askedAsWorkspace = await readEmbeddedProvenanceRecord("/home/user/some-unrelated-project", goodReader);
    expect(askedAsWorkspace).toBeNull();
    const askedAsExtensionRoot = await readEmbeddedProvenanceRecord(EXTENSION_ROOT, goodReader);
    expect(askedAsExtensionRoot?.dist).toEqual(dist);
    expect(askedAsExtensionRoot?.engineChannel).toBe("stable");
    expect(await readEmbeddedProvenanceRecord(
      EXTENSION_ROOT,
      fakeFsServing(recordPath, JSON.stringify({ version: "0.55.91", engineChannel: "candidate", dist })),
    )).toBeNull();

    // (b) one dist file's hash differs → a dist-mismatch warning naming that file.
    const tamperedReader = fakeFsServing(recordPath, embeddedRecordJson({ "dist/extension.js": "expected-hash" }));
    const tampered = await runCheck(EXTENSION_ROOT, undefined, tamperedReader, { "dist/extension.js": "actual-hash" });
    expect(tampered).toHaveLength(1);
    expect(tampered[0]?.kind).toBe("dist-mismatch");
    expect(tampered[0]?.message).toContain("dist/extension.js");

    // (c) no embedded provenance.json at all (marketplace-clean build lacking it, or a dev build) →
    // the record-read returns null and assessBuildProvenance stays silent — no false alarm.
    const noRecordReader: ReadFile = async () => null;
    const missingRecord = await readEmbeddedProvenanceRecord(EXTENSION_ROOT, noRecordReader);
    expect(missingRecord).toBeNull();
    const silentWhenAbsent = await runCheck(EXTENSION_ROOT, "/home/user/some-unrelated-project", noRecordReader, {});
    expect(silentWhenAbsent).toEqual([]);

    // (d) the resolver ignores workspaceRoot entirely — same verdict no matter what workspace (or none) is open.
    const withWorkspaceA = await runCheck(EXTENSION_ROOT, "/workspace/a", goodReader, dist);
    const withWorkspaceB = await runCheck(EXTENSION_ROOT, "/workspace/b", goodReader, dist);
    const withNoWorkspace = await runCheck(EXTENSION_ROOT, undefined, goodReader, dist);
    expect(withWorkspaceA).toEqual(withWorkspaceB);
    expect(withWorkspaceA).toEqual(withNoWorkspace);
  });

  it(".vscodeignore keeps the embedded record allowlisted, or it silently never ships in the vsix", () => {
    const raw = fs.readFileSync(path.join(__dirname, "../../apps/vscode-extension/.vscodeignore"), "utf8");
    const lines = raw.split("\n").map((l) => l.trim());
    expect(lines).toContain("!provenance.json");
  });
});
