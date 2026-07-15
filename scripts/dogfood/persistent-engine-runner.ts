import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requestEngineControl } from "../../src/engine-service/controlClient.js";
import { stagePackagedEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  engineRuntimeDir,
  engineSystemdUnitName,
  ensureDaemonEngine,
} from "../../src/engine-service/engineSupervisor.js";
import type { EngineServiceIdentityV1 } from "../../src/engine-service/protocol.js";
import { connectRemoteWorkspaceClient, type WorkspaceClient } from "../../src/shell/WorkspaceClient.js";
import { ClientWorkspaceStudioTarget } from "../../src/shell/ClientWorkspaceStudioTarget.js";
import { workspacePluginPresentationTarget } from "../../src/shell/WorkspacePresentation.js";
import { TmuxService } from "../../src/tmux/TmuxService.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import type { StudioDeps } from "../../src/webview/studioSubmit.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-dogfood-"));
const workspaceRoot = path.join(root, "workspace");
const storageRoot = path.join(root, "state");
const installRoot = path.join(root, "bundles");
for (const directory of [workspaceRoot, storageRoot]) fs.mkdirSync(directory, { mode: 0o700 });
fs.writeFileSync(path.join(workspaceRoot, "tachyon.yml"), [
  "agents:",
  "  dogfood-worker:",
  "    cmd: sleep 300",
  "    kind: agent",
  "    autostart: false",
  "",
].join("\n"), "utf8");

const unitName = engineSystemdUnitName(workspaceRoot);
let identity: EngineServiceIdentityV1 | undefined;
try {
  const bundle = stagePackagedEngineBundle({
    extensionRoot: process.cwd(),
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
  const dispositions: string[] = [];
  const ensure = async (options: Parameters<typeof ensureDaemonEngine>[0]) => {
    const result = await ensureDaemonEngine(options);
    dispositions.push(result.disposition);
    return result;
  };

  const [first, second] = await Promise.all([
    connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle,
      shell: { id: "dogfood-shell-one", version: "dogfood", locale: "en" },
      supervisor: ensureOptions,
      ensure,
    }),
    connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle,
      shell: { id: "dogfood-shell-two", version: "dogfood", locale: "en" },
      supervisor: ensureOptions,
      ensure,
    }),
  ]);
  if (first.identity.instanceId !== second.identity.instanceId
    || first.identity.pid !== second.identity.pid
    || first.identity.bridge.instanceId !== second.identity.bridge.instanceId) {
    throw new Error("concurrent systemd starters did not converge on one engine identity");
  }
  identity = first.identity;
  await expectLoopbackListener(identity.bridge.port);
  const snapshot = first.snapshot;
  if (snapshot.engineInstanceId !== identity.instanceId || second.snapshot.engineInstanceId !== identity.instanceId) {
    throw new Error("shell attach/snapshot crossed engine identities");
  }
  const probes = await first.query({ schemaVersion: 1, method: "probe.view", input: { caller: "dogfood-worker" } });
  if (probes.status !== "ok" || probes.view.caller !== "dogfood-worker" || !probes.view.empty) {
    throw new Error(`remote Probe query failed: ${JSON.stringify(probes)}`);
  }
  const studio = new ClientWorkspaceStudioTarget(first, {
    extensionUri: {} as StudioDeps["extensionUri"],
    detectClis: async () => [],
    operationId: () => "dogfood-operation-studio-0001",
  });
  const studioSubmit = { state: { ...blankCommandFields(), name: "dogfood-check", cmd: "printf dogfood" } };
  if (await studio.studioSubmit(studioSubmit) !== undefined
    || await studio.studioSubmit(studioSubmit) !== undefined
    || studio.config?.commands["dogfood-check"]?.cmd !== "printf dogfood") {
    throw new Error("idempotent remote Studio submit did not persist through the engine");
  }
  const startCommand = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "dogfood-worker" } };
  const started = await first.invoke("dogfood-operation-start-0001", startCommand);
  const replayedStart = await first.invoke("dogfood-operation-start-0001", startCommand);
  if (started.status !== "ok" || replayedStart.status !== "ok") {
    throw new Error(`idempotent remote agent start failed: ${JSON.stringify({ started, replayedStart })}`);
  }
  await waitForAgentProjection(first, "dogfood-worker", true);
  const pluginFleet = await workspacePluginPresentationTarget(first).pluginFleet();
  if (pluginFleet.agents.length !== 1
    || pluginFleet.agents[0]?.name !== "dogfood-worker"
    || pluginFleet.agents[0]?.status === "stopped") {
    throw new Error(`remote plugin fleet projection failed: ${JSON.stringify(pluginFleet.agents)}`);
  }
  const restarted = await first.invoke("dogfood-operation-restart-0001", {
    schemaVersion: 1,
    method: "agent.restart",
    input: { agent: "dogfood-worker" },
  });
  if (restarted.status !== "ok") throw new Error(`remote agent restart failed: ${JSON.stringify(restarted)}`);
  await waitForAgentProjection(first, "dogfood-worker", true);
  const killed = await first.invoke("dogfood-operation-kill-0001", {
    schemaVersion: 1,
    method: "agent.kill",
    input: { agent: "dogfood-worker" },
  });
  if (killed.status !== "ok") throw new Error(`remote agent kill failed: ${JSON.stringify(killed)}`);
  await waitForAgentProjection(first, "dogfood-worker", false);
  await Promise.all([first.close(), second.close()]);

  const reused = await ensureDaemonEngine(ensureOptions);
  if (reused.disposition !== "reused-exact" || reused.identity.instanceId !== identity.instanceId) {
    throw new Error("repeat ensure did not reuse the exact running engine");
  }
  const health = await requestEngineControl(reused.controlSocketPath, {
    schemaVersion: 1,
    op: "health",
    workspaceHash: identity.workspaceHash,
  });
  if (!health.ok || health.op !== "health" || health.shellCount !== 0) {
    throw new Error("detached dogfood shells leaked a live lease");
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    unitName,
    concurrent: dispositions,
    reused: reused.disposition,
    engine: { pid: identity.pid, instanceId: identity.instanceId, bundleId: identity.bundleId },
    bridge: identity.bridge,
    snapshotSeq: snapshot.seq,
    queries: [probes.method],
    pluginFleet: pluginFleet.agents.map((agent) => ({ name: agent.name, status: agent.status })),
    commands: ["studio.submit", started.method, restarted.method, killed.method],
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

function agentRunning(snapshot: { projections: Record<string, unknown> }, name: string): boolean {
  const projection = snapshot.projections.agents;
  if (!projection || typeof projection !== "object" || !Array.isArray((projection as { items?: unknown }).items)) return false;
  return ((projection as { items: Array<{ name?: unknown; running?: unknown }> }).items)
    .some((agent) => agent.name === name && agent.running === true);
}

async function waitForAgentProjection(
  client: WorkspaceClient,
  name: string,
  running: boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed: unknown;
  while (Date.now() < deadline) {
    const snapshot = (await client.sync()).snapshot;
    observed = snapshot.projections.agents;
    if (agentRunning(snapshot, name) === running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`remote agent projection did not converge to running=${running}: ${JSON.stringify(observed)}`);
}
