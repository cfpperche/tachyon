import fs from "node:fs";
import { writeVerificationRecord, type VerifyTaskRecord } from "../../src/bridge/verifyTask.js";

const [workspace, recordFile, readyFile, startFile, callingFile, postCheckFile, releaseFile, resultFile] = process.argv.slice(2);
if (!workspace || !recordFile || !readyFile || !startFile || !callingFile || !postCheckFile || !releaseFile || !resultFile) {
  throw new Error("publisher child arguments are required");
}

fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(startFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
fs.writeFileSync(callingFile, "calling");

try {
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as VerifyTaskRecord;
  const publishedPath = writeVerificationRecord(workspace, record, { afterConflictCheck: () => {
    fs.writeFileSync(postCheckFile, "post-check");
    while (!fs.existsSync(releaseFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } });
  fs.writeFileSync(resultFile, JSON.stringify({ ok: true, path: publishedPath, bytes: fs.readFileSync(publishedPath, "utf8") }));
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error) }));
}
