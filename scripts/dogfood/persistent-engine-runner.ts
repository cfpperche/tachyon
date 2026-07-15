import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { requestEngineControl } from "../../src/engine-service/controlClient.js";
import { stageEngineBundle, stagePackagedEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  engineRuntimeDir,
  engineSystemdUnitName,
  ensureDaemonEngine,
} from "../../src/engine-service/engineSupervisor.js";
import type { EngineBundleManifestV1, EngineServiceIdentityV1 } from "../../src/engine-service/protocol.js";
import { connectRemoteWorkspaceClient, type WorkspaceClient } from "../../src/shell/WorkspaceClient.js";
import { workspaceActivityTarget } from "../../src/shell/ActivityTarget.js";
import { workspaceHandoffTarget } from "../../src/shell/HandoffTarget.js";
import { ClientWorkspaceStudioTarget } from "../../src/shell/ClientWorkspaceStudioTarget.js";
import { workspacePluginPresentationTarget } from "../../src/shell/WorkspacePresentation.js";
import { workspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { workspacePinStudioTarget } from "../../src/shell/PinStudioTarget.js";
import { workspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";
import { workspaceTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { workspaceTaskStudioTarget } from "../../src/shell/TaskStudioTarget.js";
import { PinStore } from "../../src/pins/PinStore.js";
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
const dogfoodPinStore = new PinStore(workspaceRoot);
const dogfoodPin = dogfoodPinStore.create("persistent Pin Studio dogfood", "human", { tags: ["ui"] });

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
  const packagedManifest = JSON.parse(fs.readFileSync(bundle.manifestPath, "utf8")) as EngineBundleManifestV1;
  const previousBundle = stageEngineBundle({
    sourceRoot: bundle.root,
    manifest: { ...packagedManifest, engineVersion: previousDogfoodVersion(packagedManifest.engineVersion) },
    installRoot,
    requireCleanBuild: false,
  });
  const prior = await ensureDaemonEngine({ ...ensureOptions, bundle: previousBundle });
  if (prior.disposition !== "started" || prior.identity.bundleId !== previousBundle.bundleId) {
    throw new Error("dogfood could not establish the verified prior engine bundle");
  }
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
  if (!dispositions.includes("upgraded")
    || first.identity.instanceId === prior.identity.instanceId
    || first.identity.bundleId !== bundle.bundleId) {
    throw new Error(`controlled systemd upgrade did not activate the packaged bundle: ${JSON.stringify(dispositions)}`);
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
  const activity = workspaceActivityTarget(first);
  const activityContext = await activity.activityContext("dogfood-worker");
  if (activityContext.agent !== "dogfood-worker" || activityContext.sharedCwd || activityContext.targets.total !== 0) {
    throw new Error(`remote Activity context failed: ${JSON.stringify(activityContext)}`);
  }
  const handoff = workspaceHandoffTarget(first);
  const coldHandoff = await handoff.loadHandoff();
  if (coldHandoff.exists || coldHandoff.canonicalRelativePath !== ".tachyon/HANDOFF.md"
    || coldHandoff.distillTargets[0]?.name !== "dogfood-worker"
    || coldHandoff.distillTargets[0]?.state !== "stopped") {
    throw new Error(`remote Project Handoff cold projection failed: ${JSON.stringify(coldHandoff)}`);
  }
  const handoffFile = await handoff.ensureHandoffFile();
  if (handoffFile !== fs.realpathSync(path.join(workspaceRoot, ".tachyon", "HANDOFF.md"))
    || !fs.readFileSync(handoffFile, "utf8").includes("## Current State")) {
    throw new Error("remote Project Handoff ensure/hydration failed");
  }
  if (!(await handoff.loadHandoff()).exists) throw new Error("remote Project Handoff did not observe its ensured file");
  const sidebar = workspaceSidebarTarget(first);
  const initialSidebar = await sidebar.loadSidebar();
  if (initialSidebar.folder.hash !== identity.workspaceHash
    || initialSidebar.bridge.port !== String(identity.bridge.port)
    || initialSidebar.agents[0]?.name !== "dogfood-worker"
    || initialSidebar.agents[0]?.status !== "stopped"
    || initialSidebar.pins[0]?.id !== dogfoodPin.id
    || !initialSidebar.handoff.exists) {
    throw new Error(`remote Sidebar projection failed: ${JSON.stringify(initialSidebar)}`);
  }
  const sidebarMutation = await sidebar.mutateSidebar({ action: "pin.toggle", id: dogfoodPin.id, done: true });
  if (!sidebarMutation.changed
    || !(await sidebar.loadSidebar()).pins.some((pin) => pin.id === dogfoodPin.id && pin.done)) {
    throw new Error(`remote Sidebar mutation failed: ${JSON.stringify(sidebarMutation)}`);
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
  const taskStudio = workspaceTaskStudioTarget(first);
  const initialStudio = await taskStudio.loadTaskStudio(dogfoodTask.id);
  if (initialStudio.taskId !== dogfoodTask.id
    || initialStudio.title !== "persistent Mission Control dogfood"
    || initialStudio.attachments[0]?.id !== dogfoodImage.id
    || initialStudio.anchor !== "load") {
    throw new Error(`remote Task Studio projection failed: ${JSON.stringify(initialStudio)}`);
  }
  const studioSaved = await taskStudio.saveTaskStudio(dogfoodTask.id, {
    title: "persistent Task Studio dogfood",
    deps: [],
    artifact_refs: [],
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "remote Task Studio body" }] }] },
    attachments: [dogfoodImage],
    bodyBaseline: dogfoodTask.body,
    dirty: { title: true },
    docDirty: true,
    expectUpdatedAt: dogfoodTask.updatedAt,
  });
  if (studioSaved.status !== "ok") throw new Error(`remote Task Studio save failed: ${JSON.stringify(studioSaved)}`);
  dogfoodTask = dogfoodTaskStore.get(dogfoodTask.id);
  if (dogfoodTask.title !== "persistent Task Studio dogfood" || dogfoodTask.body !== "remote Task Studio body") {
    throw new Error("remote Task Studio save did not persist through the engine");
  }
  const taskStudioImage = await taskStudio.putTaskStudioImage(dogfoodTask.id, {
    data: Buffer.from("persistent Task Studio image"),
    mediaType: "image/png",
    name: "task-studio.png",
    source: "paste",
  });
  if (taskStudioImage.attachment.kind !== "image"
    || taskStudioImage.attachment.uri !== `data:image/png;base64,${Buffer.from("persistent Task Studio image").toString("base64")}`) {
    throw new Error("remote Task Studio image staging/hydration failed");
  }
  const pinStudio = workspacePinStudioTarget(first);
  const pinContext = { asWebviewUri: (file: string) => file };
  const initialPin = await pinStudio.loadPinStudio(dogfoodPin.id, pinContext);
  if (initialPin.pinId !== dogfoodPin.id || initialPin.title !== "persistent Pin Studio dogfood" || initialPin.tags[0] !== "ui") {
    throw new Error(`remote Pin Studio projection failed: ${JSON.stringify(initialPin)}`);
  }
  const pinSaved = await pinStudio.savePinStudio(dogfoodPin.id, {
    title: "persistent Pin Studio edited",
    tags: ["docs"],
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "remote Pin Studio body" }] }] },
    attachments: [],
  });
  if (pinSaved.status !== "ok"
    || dogfoodPinStore.readDetail(dogfoodPin.id).summary.text !== "persistent Pin Studio edited") {
    throw new Error(`remote Pin Studio save failed: ${JSON.stringify(pinSaved)}`);
  }
  const pinImage = await pinStudio.putPinStudioImage({
    data: Buffer.from("persistent Pin Studio image"),
    mediaType: "image/png",
    name: "pin-studio.png",
    source: "paste",
  }, pinContext);
  if (pinImage.attachment.kind !== "image" || !pinImage.attachment.uri
    || fs.readFileSync(pinImage.attachment.uri, "utf8") !== "persistent Pin Studio image") {
    throw new Error("remote Pin Studio image staging/hydration failed");
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
  await taskStudio.importTaskStudioPrototype(dogfoodTask.id, {
    title: "task-studio.html",
    html: "<main>persistent Task Studio import</main>",
  });
  if (!new TaskPrototypeStore(workspaceRoot, dogfoodTask.id).read().prototypes
    .some((prototype) => prototype.title === "task-studio.html" && prototype.state === "draft")) {
    throw new Error("remote Task Studio prototype import did not persist through the engine");
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
  let soulOperation = 0;
  const soulStudio = new ClientWorkspaceStudioTarget(first, {
    extensionUri: {} as StudioDeps["extensionUri"],
    detectClis: async () => [],
    operationId: () => `dogfood-soul-operation-${String(++soulOperation).padStart(4, "0")}`,
  });
  const soulCreated = await soulStudio.createSoulProfile("dogfood-worker");
  if (soulCreated.status.lifecycle !== "active"
    || !soulCreated.status.soulEnabled
    || !soulCreated.status.sha256) {
    throw new Error(`remote SOUL creation failed: ${JSON.stringify(soulCreated)}`);
  }
  const soulReplacement = Buffer.from("# Dogfood worker\n\nPersistent-engine SOUL replacement.\n");
  const soulReplaced = await soulStudio.replaceSoulProfileBytes(
    "dogfood-worker",
    soulReplacement,
    soulCreated.status.sha256,
  );
  if (soulReplaced.status.lifecycle !== "active"
    || soulReplaced.status.sha256 === soulCreated.status.sha256
    || fs.readFileSync(await soulStudio.canonicalSoulPathForOpen("dogfood-worker")).compare(soulReplacement) !== 0) {
    throw new Error(`remote SOUL replacement failed: ${JSON.stringify(soulReplaced)}`);
  }
  const soulDisabled = await soulStudio.disableSoulProfile("dogfood-worker");
  if (soulDisabled.status.lifecycle !== "retained"
    || soulDisabled.status.soulEnabled
    || soulDisabled.status.resolvable) {
    throw new Error(`remote SOUL disable/retention failed: ${JSON.stringify(soulDisabled)}`);
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
  await expectAgentStopped(first, "after Studio config reload");
  const startCommand = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "dogfood-worker" } };
  const started = await first.invoke("dogfood-operation-start-0001", startCommand);
  const replayedStart = await first.invoke("dogfood-operation-start-0001", startCommand);
  if (started.status !== "ok" || replayedStart.status !== "ok") {
    throw new Error(`idempotent remote agent start failed: ${JSON.stringify({ started, replayedStart })}`);
  }
  await waitForAgentProjection(first, "dogfood-worker", true);
  await activity.sendAgentInput("dogfood-worker", "persistent Activity share dogfood", false);
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

  const brokenSource = path.join(root, "broken-engine-source");
  fs.cpSync(bundle.root, brokenSource, { recursive: true });
  const brokenEntrypoint = path.join(brokenSource, ...packagedManifest.entrypoint.split("/"));
  const brokenEntrypointBytes = Buffer.from("process.exit(1);\n");
  fs.chmodSync(brokenEntrypoint, 0o600);
  fs.writeFileSync(brokenEntrypoint, brokenEntrypointBytes);
  const brokenManifest: EngineBundleManifestV1 = {
    ...packagedManifest,
    engineVersion: nextDogfoodVersion(packagedManifest.engineVersion),
    files: packagedManifest.files.map((file) => file.path === packagedManifest.entrypoint
      ? { ...file, sha256: createHash("sha256").update(brokenEntrypointBytes).digest("hex") }
      : file),
  };
  const brokenBundle = stageEngineBundle({
    sourceRoot: brokenSource,
    manifest: brokenManifest,
    installRoot,
    requireCleanBuild: false,
  });
  const beforeRollback = identity;
  let rollbackCode: unknown;
  try {
    await ensureDaemonEngine({ ...ensureOptions, bundle: brokenBundle, startTimeoutMs: 3_000 });
  } catch (error) {
    rollbackCode = (error as { code?: unknown }).code;
  }
  if (rollbackCode !== "ENGINE_UPGRADE_ROLLED_BACK") {
    throw new Error(`failed packaged engine did not produce a verified rollback: ${String(rollbackCode)}`);
  }
  const afterRollback = await ensureDaemonEngine(ensureOptions);
  if (afterRollback.disposition !== "reused-exact"
    || afterRollback.identity.bundleId !== bundle.bundleId
    || afterRollback.identity.instanceId === beforeRollback.instanceId) {
    throw new Error("verified rollback did not restore the packaged engine as a new incarnation");
  }
  identity = afterRollback.identity;
  const beforeCrash = identity;
  process.kill(beforeCrash.pid, "SIGKILL");
  await waitForEngineRestart(
    afterRollback.controlSocketPath,
    beforeCrash.workspaceHash,
    beforeCrash.instanceId,
    beforeCrash.bundleId,
    15_000,
  );
  const afterCrash = await ensureDaemonEngine(ensureOptions);
  if (afterCrash.disposition !== "reused-exact"
    || afterCrash.identity.bundleId !== beforeCrash.bundleId
    || afterCrash.identity.instanceId === beforeCrash.instanceId
    || afterCrash.identity.processStartIdentity === beforeCrash.processStartIdentity) {
    throw new Error("systemd crash recovery did not restart the exact staged bundle as a new incarnation");
  }
  identity = afterCrash.identity;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    unitName,
    concurrent: dispositions,
    upgradedFrom: { pid: prior.identity.pid, instanceId: prior.identity.instanceId, bundleId: prior.identity.bundleId },
    rolledBackFrom: { bundleId: brokenBundle.bundleId, engineVersion: brokenManifest.engineVersion },
    crashRestartedFrom: { pid: beforeCrash.pid, instanceId: beforeCrash.instanceId },
    reused: reused.disposition,
    engine: { pid: identity.pid, instanceId: identity.instanceId, bundleId: identity.bundleId },
    bridge: identity.bridge,
    snapshotSeq: snapshot.seq,
    queries: ["activity.context", probes.method, "handoff.view", "sidebar.view", "task.board", "task.detail", "task.studio", "pin.studio", "soul.profile.status"],
    pluginFleet: pluginFleet.agents.map((agent) => ({ name: agent.name, status: agent.status })),
    commands: ["handoff.ensure", "sidebar.mutate", "agent.input", "pin.studio.apply", "task.studio.apply", "task.prototype.review", "task.update", "task.reorder-lane", "validation.close", "studio.submit", "soul.profile.create", "soul.profile.replace", "soul.profile.disable", started.method, restarted.method, killed.method],
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

function previousDogfoodVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`packaged engine version is not a stable semantic version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999999`;
  if (major > 0) return `${major - 1}.999999.999999`;
  throw new Error("packaged engine version has no lower dogfood predecessor");
}

function nextDogfoodVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`packaged engine version is not a stable semantic version: ${version}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("persistent engine cleanup timed out");
}

async function waitForEngineRestart(
  socketPath: string,
  expectedWorkspaceHash: string,
  priorInstanceId: string,
  expectedBundleId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await requestEngineControl(socketPath, {
        schemaVersion: 1,
        op: "health",
        workspaceHash: expectedWorkspaceHash,
      }, 750);
      if (response.ok && response.op === "health"
        && response.engine.instanceId !== priorInstanceId
        && response.engine.bundleId === expectedBundleId) return;
    } catch {
      // The old socket is briefly absent/refused while systemd starts the exact staged bundle again.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("persistent engine crash restart timed out");
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
