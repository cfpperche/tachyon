import { startDaemonEngineService } from "../../src/engine-service/engineService.js";

async function main(): Promise<void> {
  const [workspaceRoot, storageRoot, mediaRoot, controlSocketPath] = process.argv.slice(2);
  if (!workspaceRoot || !storageRoot || !mediaRoot || !controlSocketPath) {
    throw new Error("usage: daemonEngineServiceWorker <workspaceRoot> <storageRoot> <mediaRoot> <controlSocketPath>");
  }
  const service = await startDaemonEngineService({
    workspaceRoot,
    storageRoot,
    mediaRoot,
    controlSocketPath,
    appVersion: "0.57.0-engine-test",
    bundleId: "a".repeat(64),
  });
  process.stdout.write(`TACHYON_ENGINE_READY ${JSON.stringify(service.identity)}\n`);

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
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
