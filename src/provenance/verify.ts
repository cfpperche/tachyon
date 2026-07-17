export interface BuildStamp {
  commit: string | null;
  treeSha: string | null;
  dirty: boolean;
}

export interface DeployRecord {
  version: string;
  engineChannel?: "stable" | "dev" | null;
  commit: string | null;
  treeSha: string | null;
  workingTreeClean: boolean;
  packagedBy: string;
  vsix: { path: string; sha256: string | null };
  dist: Record<string, string>;
  verify: { command: string; result: string };
  note: string;
}

/**
 * The record activation actually reads: embedded inside the extension itself (provenance.json at
 * the extension root), not the human audit trail (.tachyon/deploys/<version>.json, which additionally
 * carries the vsix's own sha256, packagedBy, and the verify:full result — see scripts/record-provenance.mjs).
 * It's a strict subset of DeployRecord's fields.
 */
export type EmbeddedProvenanceRecord = Pick<DeployRecord, "version" | "engineChannel" | "commit" | "treeSha" | "workingTreeClean" | "dist">;

export type HashReader = (relPath: string) => Promise<string | null>;

export type ProvenanceWarning =
  | { kind: "dirty"; message: string }
  | { kind: "dist-mismatch"; message: string; file: string };

const DIRTY_MESSAGE = "Tachyon is running an unverified build (made from uncommitted source)";

/**
 * Dogfood detector, not a security boundary: local agents share one OS user and can forge both a bundle and its
 * record. This only catches accidents and lazy out-of-band installs, so user-facing language stays "unverified build".
 */
export async function assessBuildProvenance(input: {
  version: string;
  stamp: BuildStamp;
  record: EmbeddedProvenanceRecord | null;
  hashDistFile: HashReader;
}): Promise<ProvenanceWarning[]> {
  if (input.stamp.dirty || input.stamp.commit === null) return [{ kind: "dirty", message: DIRTY_MESSAGE }];
  if (!input.record) return [];

  const warnings: ProvenanceWarning[] = [];
  for (const relPath of Object.keys(input.record.dist).sort()) {
    const expected = input.record.dist[relPath];
    const actual = await input.hashDistFile(relPath);
    if (actual !== expected) {
      warnings.push({
        kind: "dist-mismatch",
        file: relPath,
        message: `Tachyon is running an unverified build: ${relPath} does not match the recorded deploy of ${input.version}`,
      });
    }
  }
  return warnings;
}
