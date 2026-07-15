import fs from "node:fs";
import path from "node:path";

export function writePrivateFileAtomic(file: string, body: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function removeDerivedAgentFiles(workspaceRoot: string, agent: string): void {
  const failures: unknown[] = [];
  for (const file of [
    path.join(workspaceRoot, ".tachyon", "briefs", "spawn", `${agent}.md`),
    path.join(workspaceRoot, ".tachyon", "anchors", `${agent}.md`),
  ]) {
    try { fs.rmSync(file, { force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `failed to remove agent '${agent}' derived files`);
}
