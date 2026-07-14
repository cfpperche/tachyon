import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import { stageEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  engineRuntimeDir,
  engineSystemdUnitName,
  ensureDaemonEngine,
} from "../../src/engine-service/engineSupervisor.js";
import { isEngineBundleManifestV1, type EngineServiceIdentityV1, type EngineShellHelloV1 } from "../../src/engine-service/protocol.js";
import { TmuxService } from "../../src/tmux/TmuxService.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-dogfood-"));
const workspaceRoot = path.join(root, "workspace");
const storageRoot = path.join(root, "state");
const installRoot = path.join(root, "bundles");
for (const directory of [workspaceRoot, storageRoot]) fs.mkdirSync(directory, { mode: 0o700 });
fs.writeFileSync(path.join(workspaceRoot, "tachyon.yml"), [
  "agents:",
  "  dogfood-worker:",
  "    cmd: sh",
  "    autostart: false",
  "",
].join("\n"), "utf8");

const unitName = engineSystemdUnitName(workspaceRoot);
let identity: EngineServiceIdentityV1 | undefined;
try {
  const manifestValue: unknown = JSON.parse(fs.readFileSync("dist/engine/engine-manifest.json", "utf8"));
  if (!isEngineBundleManifestV1(manifestValue)) throw new Error("dist/engine manifest is invalid; run npm run build first");
  const bundle = stageEngineBundle({
    sourceRoot: path.resolve("dist/engine"),
    manifest: manifestValue,
    installRoot,
    // Local dogfood may intentionally run before the candidate commit. Marketplace builds remain clean-only.
    requireCleanBuild: false,
  });
  const ensureOptions = {
    workspaceRoot,
    storageRoot,
    bundle,
    startTimeoutMs: 15_000,
    pollMs: 25,
  } as const;

  const [first, second] = await Promise.all([
    ensureDaemonEngine(ensureOptions),
    ensureDaemonEngine(ensureOptions),
  ]);
  if (first.identity.instanceId !== second.identity.instanceId
    || first.identity.pid !== second.identity.pid
    || first.identity.bridge.instanceId !== second.identity.bridge.instanceId) {
    throw new Error("concurrent systemd starters did not converge on one engine identity");
  }
  identity = first.identity;
  await expectLoopbackListener(identity.bridge.port);

  const client = new EngineControlClient({ socketPath: first.controlSocketPath, hello: hello(identity) });
  const session = await client.attach();
  const snapshot = await client.snapshot();
  if (session.engine.instanceId !== identity.instanceId || snapshot.engineInstanceId !== identity.instanceId) {
    throw new Error("shell attach/snapshot crossed engine identities");
  }
  await client.detach();
  if ((await client.health()).shellCount !== 0) throw new Error("detached dogfood shell leaked a lease");

  const reused = await ensureDaemonEngine(ensureOptions);
  if (reused.disposition !== "reused-exact" || reused.identity.instanceId !== identity.instanceId) {
    throw new Error("repeat ensure did not reuse the exact running engine");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    unitName,
    concurrent: [first.disposition, second.disposition],
    reused: reused.disposition,
    engine: { pid: identity.pid, instanceId: identity.instanceId, bundleId: identity.bundleId },
    bridge: identity.bridge,
    snapshotSeq: snapshot.seq,
  }, null, 2)}\n`);
} finally {
  try { execFileSync("systemctl", ["--user", "stop", unitName], { stdio: "ignore" }); } catch { /* absent/failed unit */ }
  await waitUntil(() => !fs.existsSync(path.join(engineRuntimeDir(workspaceRoot), "control.sock")), 10_000)
    .catch(() => undefined);
  if (identity && await new TmuxService().hasSession(`tachyon-ctl-${identity.workspaceHash}`)) {
    throw new Error("persistent engine dogfood left its tmux control anchor running");
  }
  fs.rmSync(engineRuntimeDir(workspaceRoot), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

function hello(identity: EngineServiceIdentityV1): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: identity.workspaceRoot,
    workspaceHash: identity.workspaceHash,
    shell: { id: "dogfood-shell", version: "dogfood", locale: "en" },
    protocol: { min: 1, max: 1 },
    capabilities: [],
    settingsDigest: createHash("sha256").update("dogfood-settings").digest("hex"),
  };
}

function expectLoopbackListener(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Bridge listener ${port} timed out`));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("persistent engine cleanup timed out");
}
