export type ShipFileClassification = "allowed" | "dev-artifact" | "forbidden";

export function classifyShipFile(relPath: string): ShipFileClassification;

export function engineManifestClosureViolations(
  engineDir: string,
  manifest: { files?: Array<{ path: string; sha256: string }> },
  deps?: { fs?: Pick<typeof import("node:fs"), "readFileSync">; crypto?: Pick<typeof import("node:crypto"), "createHash"> },
): string[];
