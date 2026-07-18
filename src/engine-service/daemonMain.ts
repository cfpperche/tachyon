import fs from "node:fs";
import path from "node:path";
import { ensureSecureRuntimeDir } from "./runtimeSecurity.js";
import { workspaceHash } from "../tmux/TmuxService.js";
import { EngineControlClientError, requestEngineControl } from "./controlClient.js";
import { startDaemonEngineService, type RunningDaemonEngineService } from "./engineService.js";
import { decodeEngineDaemonOptions } from "./engineSupervisor.js";
import { controlNoncePath } from "./controlPeerAuth.js";

export async function runEngineDaemon(encodedOptions: string): Promise<RunningDaemonEngineService> {
  const options = decodeEngineDaemonOptions(encodedOptions);
  ensureSecureRuntimeDir(path.dirname(options.controlSocketPath));
  await removeStaleSocket(options.controlSocketPath, workspaceHash(fs.realpathSync(options.workspaceRoot)));
  const service = await startDaemonEngineService(options);
  process.title = `tachyon-engine:${service.identity.workspaceHash}`;
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void service.close().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return service;
}

async function removeStaleSocket(socketPath: string, expectedWorkspaceHash: string): Promise<void> {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("persistent engine control path is not a stale socket");
  try {
    // Any valid response proves a live owner, including a workspace-mismatch refusal.  Never disconnect
    // that owner merely because another process reached the same path.
    await requestEngineControl(socketPath, { schemaVersion: 1, op: "health", workspaceHash: expectedWorkspaceHash }, 750);
    throw new Error("persistent engine control socket already has a live owner");
  } catch (error) {
    if (!(error instanceof EngineControlClientError)
      || error.code !== "UNAVAILABLE"
      || (error.systemCode !== "ECONNREFUSED" && error.systemCode !== "ENOENT")) throw error;
  }
  let current: fs.Stats;
  try { current = fs.lstatSync(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isSocket() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
    throw new Error("persistent engine control socket identity changed during stale cleanup");
  }
  fs.unlinkSync(socketPath);
  fs.rmSync(controlNoncePath(socketPath), { force: true });
}

if (require.main === module) {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("missing persistent engine daemon options");
  void runEngineDaemon(encoded).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
