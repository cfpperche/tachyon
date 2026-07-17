import path from "node:path";
import type { EmbeddedProvenanceRecord } from "./verify.js";

export type ReadFile = (absPath: string) => Promise<string | null>;

/**
 * The embedded record lives at the extension's own root (provenance.json), never inside a
 * workspace — the extension's provenance is a fact about the installed extension, not any
 * project. It also lives outside dist/ so the recorder isn't hashing a file it just wrote.
 */
export function embeddedProvenancePath(extensionRoot: string): string {
  return path.join(extensionRoot, "provenance.json");
}

/** Validates only the shape assessBuildProvenance relies on; anything else is treated as absent. */
export function parseEmbeddedProvenanceRecord(raw: string): EmbeddedProvenanceRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EmbeddedProvenanceRecord>;
    if (parsed && typeof parsed === "object"
      && typeof parsed.version === "string"
      && (parsed.engineChannel === undefined || parsed.engineChannel === null
        || parsed.engineChannel === "stable" || parsed.engineChannel === "dev")
      && parsed.dist && typeof parsed.dist === "object") {
      return parsed as EmbeddedProvenanceRecord;
    }
  } catch {
    /* malformed — caller treats this the same as "no record" */
  }
  return null;
}

/**
 * Reads the extension's own embedded provenance record. Deliberately takes only extensionRoot —
 * there is no workspace parameter to plumb through, so the check is workspace-independent by
 * construction, not by convention. Missing/malformed records resolve to null (silent, not an error).
 */
export async function readEmbeddedProvenanceRecord(extensionRoot: string, readFile: ReadFile): Promise<EmbeddedProvenanceRecord | null> {
  const raw = await readFile(embeddedProvenancePath(extensionRoot));
  return raw === null ? null : parseEmbeddedProvenanceRecord(raw);
}
