/**
 * spec 250 — generic filesystem helpers shared by the plugin engine + its extracted format codecs
 * (e.g. `mcpConfig.ts`). Extracted from `engine.ts` so a config codec can read/write fail-closed without
 * importing the engine (which would be a cycle). NOT plugin-specific — just fail-closed read + atomic write.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface FileRead {
  text?: string;
  /** true ONLY for ENOENT — a genuinely absent file. Any other error (EACCES/EISDIR/…) is `error`, not absent. */
  missing: boolean;
  error?: string;
}

/** Read a file, distinguishing genuine absence (ENOENT) from an unreadable-but-present file (fail-closed). */
export function readFile(file: string): FileRead {
  try {
    return { text: fs.readFileSync(file, "utf8"), missing: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { missing: false, error: `${code ?? "read error"}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Writes via a sibling temp + atomic rename; on ANY failure (write or rename) the temp file is cleaned up
 *  before rethrowing — otherwise a write that fails AFTER creating a fresh runtime dir would leave an orphan
 *  temp, making that dir non-empty and un-rmdir'able at uninstall (defeating spec-263 createdAncestors cleanup). */
export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; surface the original failure */
    }
    throw e;
  }
}
