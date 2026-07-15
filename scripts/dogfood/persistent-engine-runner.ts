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
import { workspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { workspaceTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { sessionName, TmuxService, workspaceHash } from "../../src/tmux/TmuxService.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
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
const dogfoodTaskStore = new TaskStore(workspaceRoot);
let dogfoodTask = await dogfoodTaskStore.create({
  id: "t-d06f00",
  title: "persistent Mission Control dogfood",
  body: "remote board body",
  author: "human",
});
dogfoodTaskStore.journal.append(dogfoodTask.id, { author: "codex", text: "persistent Task Detail note" });
const dogfoodAttachments = new TaskAttachmentStore(workspaceRoot, dogfoodTask.id);
const dogfoodImage = dogfoodAttachments.putImage({
  data: Buffer.from("persistent detail image"),
  mediaType: "image/png",
  name: "detail.png",
  source: "paste",
});
new TaskDetailStore(workspaceRoot).write({
  schemaVersion: 1,
  taskId: dogfoodTask.id,
  doc: { type: "doc", content: [] },
  attachments: [dogfoodImage],
  bodyHash: hashBody(dogfoodTask.body!),
  taskUpdatedAt: dogfoodTask.updatedAt,
});
const dogfoodPrototype = new TaskPrototypeStore(workspaceRoot, dogfoodTask.id).createDraft({
  html: "<main>persistent Task Detail prototype</main>",
  title: "Persistent proposal",
  author: "codex",
});
const dogfoodRevision = dogfoodPrototype.prototypes[0]!;
dogfoodTask = await dogfoodTaskStore.update(dogfoodTask.id, {
  awaitingHuman: {
    reason: "Review persistent proposal",
    kind: "decision",
    since: new Date().toISOString(),
    subject: { type: "task-prototype", prototypeId: dogfoodRevision.id },
  },
});
const dogfoodValidation = await new ValidationStore(workspaceRoot).create({
  title: "persistent Mission Control validation",
  author: "human",
  executor: "human",
});

const unitName = engineSystemdUnitName(workspaceRoot);
const dogfoodSession = sessionName(workspaceHash(fs.realpathSync(workspaceRoot)), "dogfood-worker");
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
  if (agentRunning(snapshot, "dogfood-worker")) throw new Error("dogfood agent started before any explicit lifecycle command");
  const probes = await first.query({ schemaVersion: 1, method: "probe.view", input: { caller: "dogfood-worker" } });
  if (probes.status !== "ok" || probes.method !== "probe.view"
    || probes.view.caller !== "dogfood-worker" || !probes.view.empty) {
    throw new Error(`remote Probe query failed: ${JSON.stringify(probes)}`);
  }
  const missionControl = workspaceMissionControlTarget(first);
  const initialBoard = await missionControl.boardSnapshot(["dogfood-reviewer"]);
  if (initialBoard.views[0]?.task.id !== dogfoodTask.id
    || initialBoard.views[0]?.task.body !== "remote board body"
    || !initialBoard.chips.some((chip) => chip.agent === "dogfood-reviewer")
    || initialBoard.validations?.items[0]?.id !== dogfoodValidation.id) {
    throw new Error(`remote Mission Control projection failed: ${JSON.stringify(initialBoard)}`);
  }
  const taskDetail = workspaceTaskDetailTarget(first);
  const initialDetail = await taskDetail.loadTaskDetail(dogfoodTask.id);
  if (initialDetail.journal[0]?.text !== "persistent Task Detail note"
    || initialDetail.imageAttachments[0]?.blobRef !== dogfoodImage.blobRef
    || initialDetail.prototypes.prototypes[0]?.id !== dogfoodRevision.id
    || JSON.stringify(initialDetail).includes("persistent detail image")
    || JSON.stringify(initialDetail).includes("persistent Task Detail prototype")) {
    throw new Error(`remote Task Detail projection failed: ${JSON.stringify(initialDetail)}`);
  }
  if (fs.readFileSync(taskDetail.attachmentBlobPath(dogfoodTask.id, dogfoodImage.blobRef), "utf8") !== "persistent detail image"
    || taskDetail.prototypeHtml(dogfoodTask.id, dogfoodRevision.id) !== "<main>persistent Task Detail prototype</main>") {
    throw new Error("Task Detail shell media hydration failed");
  }
  await taskDetail.reviewPrototype(dogfoodTask.id, {
    prototypeId: dogfoodRevision.id,
    action: "approve",
    expectUpdatedAt: dogfoodPrototype.updatedAt!,
    review: "packaged dogfood approved",
  });
  dogfoodTask = dogfoodTaskStore.get(dogfoodTask.id);
  if (dogfoodTask.awaitingHuman !== undefined
    || new TaskPrototypeStore(workspaceRoot, dogfoodTask.id).read().approved?.id !== dogfoodRevision.id) {
    throw new Error("remote Task Detail prototype review did not reconcile");
  }
  await taskDetail.updateTask(dogfoodTask.id, {
    priority: 1,
    expect: { updatedAt: dogfoodTask.updatedAt },
  });
  dogfoodTask = dogfoodTaskStore.get(dogfoodTask.id);
  await missionControl.updateTask(dogfoodTask.id, {
    status: "triaged",
    expect: { status: "inbox", updatedAt: dogfoodTask.updatedAt },
  });
  const updatedBoard = await missionControl.boardSnapshot([]);
  const updatedTask = updatedBoard.views.find((view) => view.task.id === dogfoodTask.id)?.task;
  if (!updatedTask || updatedTask.status !== "triaged") throw new Error("remote Mission Control task update did not persist");
  await missionControl.reorderLane("triaged", 1, {
    orderedIds: [dogfoodTask.id],
    expect: { [dogfoodTask.id]: updatedTask.updatedAt },
  });
  await missionControl.closeValidation(dogfoodValidation.id, { outcome: "passed", result_note: "packaged dogfood passed" });
  const closedBoard = await missionControl.boardSnapshot([]);
  if (closedBoard.validations?.pendingCount !== 0 || closedBoard.validations.items.length !== 0) {
    throw new Error("remote Mission Control validation close did not persist");
  }
  await expectAgentStopped(first, "after Mission Control reads and mutations");
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
  await expectAgentStopped(first, "after Studio config reload");
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
    queries: [probes.method, "task.board", "task.detail"],
    pluginFleet: pluginFleet.agents.map((agent) => ({ name: agent.name, status: agent.status })),
    commands: ["task.prototype.review", "task.update", "task.reorder-lane", "validation.close", "studio.submit", started.method, restarted.method, killed.method],
  }, null, 2)}\n`);
} finally {
  try { execFileSync("systemctl", ["--user", "stop", unitName], { stdio: "ignore" }); } catch { /* absent/failed unit */ }
  await new TmuxService().killSession(dogfoodSession).catch(() => undefined);
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

async function expectAgentStopped(client: WorkspaceClient, stage: string): Promise<void> {
  const snapshot = (await client.sync()).snapshot;
  if (agentRunning(snapshot, "dogfood-worker")) throw new Error(`dogfood agent started unexpectedly ${stage}`);
  if (await new TmuxService().hasSession(dogfoodSession)) {
    throw new Error(`dogfood tmux session appeared unexpectedly ${stage}`);
  }
}
