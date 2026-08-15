import { runEngineDaemon as runEngineDaemonCore } from "../engine-service/daemonMain.js";
import type { RunningDaemonEngineService } from "../engine-service/engineService.js";
import { workspaceBridgePort } from "./workspaceComposition.js";

/** Product composition root: the transport is chosen here, outside the engine. */
export function runEngineDaemon(encodedOptions: string): Promise<RunningDaemonEngineService> {
  return runEngineDaemonCore(encodedOptions, workspaceBridgePort);
}

if (require.main === module) {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("missing persistent engine daemon options");
  void runEngineDaemon(encoded).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
