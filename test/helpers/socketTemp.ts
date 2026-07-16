import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Keep filesystem-socket fixtures independent of an arbitrarily long verifier TMPDIR on Linux. */
export function makeSocketTemp(prefix: string): string {
  const parent = process.platform === "linux" ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(parent, prefix));
}
