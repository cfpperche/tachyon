import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackTempDir } from "./tempDir.js";

/** Keep filesystem-socket fixtures independent of an arbitrarily long verifier TMPDIR on Linux. */
export function makeSocketTemp(prefix: string): string {
  const parent = process.platform === "linux" ? "/tmp" : os.tmpdir();
  // t-25a908 — tracked, so the socket fixtures stop leaking a directory per call.
  return trackTempDir(fs.mkdtempSync(path.join(parent, prefix)));
}
