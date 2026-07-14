import { runEngineDaemon } from "../../src/engine-service/daemonMain.js";

const encodedOptions = process.argv[2];
if (!encodedOptions) throw new Error("usage: engineSupervisorWorker <encoded-options>");

void runEngineDaemon(encodedOptions).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
