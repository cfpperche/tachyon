import { spawnSync } from "node:child_process";
import path from "node:path";
import { extensionWorkspace } from "./workspace-layout.mjs";

const repositoryRoot = process.cwd();
const entry = process.argv[2];
if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
  throw new Error("expected a relative extension dist entrypoint");
}
const target = path.join(extensionWorkspace(repositoryRoot).directory, "dist", entry);
const result = spawnSync(process.execPath, [target, ...process.argv.slice(3)], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
