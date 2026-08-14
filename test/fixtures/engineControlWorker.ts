import fs from "node:fs";
import { startEngineControlServer } from "@tachyon/engine/engine-service/controlServer.js";
import type { EngineServiceIdentityV1 } from "@tachyon/engine/engine-service/protocol.js";

async function main(): Promise<void> {
  const [workspaceRoot, socketPath] = process.argv.slice(2);
  if (!workspaceRoot || !socketPath) throw new Error("usage: engineControlWorker <workspaceRoot> <socketPath>");
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const identity: EngineServiceIdentityV1 = {
    schemaVersion: 1,
    workspaceRoot: canonicalRoot,
    workspaceHash: "process1",
    instanceId: `engine-${process.pid}`,
    pid: process.pid,
    processStartIdentity: `worker-${process.pid}`,
    startedAt: new Date().toISOString(),
    bundleId: "a".repeat(64),
    engineVersion: "0.57.0-test",
    protocol: { min: 1, max: 1 },
    bridge: { instanceId: `bridge-${process.pid}`, port: 42_897 },
  };
  const server = await startEngineControlServer({
    socketPath,
    identity,
    getSnapshot: () => ({
      schemaVersion: 1,
      engineInstanceId: identity.instanceId,
      seq: 1,
      projections: { workerPid: process.pid },
    }),
  });

  process.stdout.write(`${JSON.stringify({ ready: true, identity })}\n`);
  const shutdown = () => { void server.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
