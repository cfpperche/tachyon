import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import { StagedPayloadStore } from "../../src/engine-service/stagedPayloadStore.js";
import type { EngineServiceIdentityV1, EngineShellHelloV1, WorkspaceEventV1 } from "../../src/engine-service/protocol.js";
import { encodePinStudioStagedPayloadV1 } from "../../src/runtime-api/pinStudioCommands.js";
import { encodeTaskStudioStagedPayloadV1 } from "../../src/runtime-api/taskStudioCommands.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { TmuxService, workspaceHash } from "../../src/tmux/TmuxService.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("daemon engine service", () => {
  it("owns a real Workspace and direct Bridge across shell replacement and no-shell time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-service-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const storageRoot = path.join(root, "storage");
    const mediaRoot = path.join(root, "bundle");
    const runtimeRoot = path.join(root, "runtime");
    for (const directory of [workspaceRoot, storageRoot, mediaRoot, runtimeRoot]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const configPath = path.join(workspaceRoot, "tachyon.yml");
    fs.writeFileSync(configPath, config("worker"), "utf8");
    const seedTaskStore = new TaskStore(workspaceRoot);
    let seedTask = await seedTaskStore.create({
      id: "t-abc123",
      title: "remote Mission Control",
      author: "human",
      body: "engine-owned body",
      now: "2026-07-14T12:00:00.000Z",
    });
    seedTaskStore.journal.append(seedTask.id, {
      author: "codex",
      text: "daemon-owned detail note",
      now: "2026-07-14T12:00:01.000Z",
    });
    const seedAttachments = new TaskAttachmentStore(workspaceRoot, seedTask.id);
    const seedImage = seedAttachments.putImage({
      data: Buffer.from("daemon image bytes"),
      mediaType: "image/png",
      name: "daemon.png",
      source: "paste",
    });
    new TaskDetailStore(workspaceRoot).write({
      schemaVersion: 1,
      taskId: seedTask.id,
      doc: { type: "doc", content: [] },
      attachments: [seedImage],
      bodyHash: hashBody(seedTask.body!),
      taskUpdatedAt: seedTask.updatedAt,
    });
    const seedPrototype = new TaskPrototypeStore(workspaceRoot, seedTask.id).createDraft({
      html: "<main>daemon prototype</main>",
      title: "Daemon proposal",
      author: "codex",
      now: "2026-07-14T12:00:02.000Z",
    });
    const seedRevision = seedPrototype.prototypes[0]!;
    seedTask = await seedTaskStore.update(seedTask.id, {
      awaitingHuman: {
        reason: "Review daemon proposal",
        kind: "decision",
        since: "2026-07-14T12:00:03.000Z",
        subject: { type: "task-prototype", prototypeId: seedRevision.id },
      },
      now: "2026-07-14T12:00:03.000Z",
    });
    const seedValidation = await new ValidationStore(workspaceRoot).create({
      title: "remote dogfood",
      author: "human",
      executor: "human",
      now: "2026-07-14T12:00:00.000Z",
    });
    const seedPinStore = new PinStore(workspaceRoot);
    const seedPin = seedPinStore.create("remote Pin Studio", "human", { tags: ["ui"] });
    const socketPath = path.join(runtimeRoot, "engine.sock");
    const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
    const worker = path.join(process.cwd(), "test/fixtures/daemonEngineServiceWorker.ts");
    const child = spawn(process.execPath, [viteNode, worker, workspaceRoot, storageRoot, mediaRoot, socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const identity = await readReady(child);
    expect(identity).toMatchObject({
      pid: child.pid,
      workspaceRoot: fs.realpathSync(workspaceRoot),
      workspaceHash: workspaceHash(fs.realpathSync(workspaceRoot)),
      bridge: { port: expect.any(Number), instanceId: expect.any(String) },
    });
    expect(identity.processStartIdentity).toMatch(/^linux:[0-9a-f-]+:\d+$/);
    await expectLoopbackListener(identity.bridge.port);

    const first = new EngineControlClient({ socketPath, hello: hello(identity, "shell-old") });
    const firstSession = await first.attach();
    const initial = await first.snapshot();
    expect(initial.projections).toMatchObject({
      workspace: { root: identity.workspaceRoot, hash: identity.workspaceHash, configValid: true },
      bridge: { port: identity.bridge.port, instanceId: identity.bridge.instanceId, direct: true },
      agents: { total: 1, truncated: false, items: [{ name: "worker", declared: true, running: false }] },
    });
    expect(await first.query({ schemaVersion: 1, method: "probe.view", input: { caller: "worker" } }))
      .toEqual({
        schemaVersion: 1,
        method: "probe.view",
        status: "ok",
        view: { rows: [], total: 0, running: 0, completed: 0, failed: 0, empty: true, caller: "worker" },
      });

    const initialBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveAdhocAgents: ["reviewer"] } });
    expect(initialBoard).toMatchObject({
      method: "task.board",
      status: "ok",
      view: {
        board: {
          views: [{ task: { id: seedTask.id, title: "remote Mission Control", body: "engine-owned body", status: "inbox" } }],
          chips: [{ agent: "worker" }, { agent: "human" }, { agent: "reviewer" }],
          validations: { pendingCount: 1, humanPendingCount: 1, items: [{ id: seedValidation.id }] },
        },
      },
    });
    const initialDetail = await first.query({ schemaVersion: 1, method: "task.detail", input: { id: seedTask.id } });
    expect(initialDetail).toMatchObject({
      method: "task.detail",
      status: "ok",
      view: {
        detail: {
          task: { id: seedTask.id, title: "remote Mission Control" },
          journal: [{ author: "codex", text: "daemon-owned detail note" }],
          imageAttachments: [{ id: seedImage.id, blobRef: seedImage.blobRef, available: true }],
          prototypes: {
            updatedAt: seedPrototype.updatedAt,
            prototypes: [{ id: seedRevision.id, available: true, integrity: "verified", state: "draft" }],
          },
        },
      },
    });
    const initialStudio = await first.query({ schemaVersion: 1, method: "task.studio", input: { id: seedTask.id } });
    expect(initialStudio).toMatchObject({
      method: "task.studio",
      status: "ok",
      view: {
        studio: {
          taskId: seedTask.id,
          title: "remote Mission Control",
          attachments: [{ id: seedImage.id, kind: "image" }],
          anchor: "load",
          expectUpdatedAt: seedTask.updatedAt,
        },
      },
    });

    const stagedPayloads = new StagedPayloadStore(runtimeRoot);
    expect(await first.query({ schemaVersion: 1, method: "pin.studio", input: { id: seedPin.id } })).toMatchObject({
      method: "pin.studio",
      status: "ok",
      view: { studio: { pinId: seedPin.id, title: "remote Pin Studio", tags: ["ui"], doc: null, attachments: [] } },
    });
    const stagedPinSave = stagedPayloads.stage(encodePinStudioStagedPayloadV1({
      schemaVersion: 1,
      patch: {
        title: "edited through remote Pin Studio",
        tags: ["docs"],
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "engine pin body" }] }] },
        attachments: [],
      },
    }));
    const savePinCommand = {
      schemaVersion: 1 as const,
      method: "pin.studio.apply" as const,
      input: { action: "save" as const, pinId: seedPin.id, payload: stagedPinSave },
    };
    const savedPin = await first.invoke("operation-pin-studio-save-0001", savePinCommand);
    expect(savedPin).toEqual({
      schemaVersion: 1,
      method: "pin.studio.apply",
      status: "ok",
      action: "save",
      outcome: "saved",
      pinId: seedPin.id,
    });
    expect(fs.existsSync(path.join(stagedPayloads.directory, stagedPinSave.token))).toBe(false);
    expect(await first.invoke("operation-pin-studio-save-0001", savePinCommand)).toEqual(savedPin);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "pins");
    expect(seedPinStore.readDetail(seedPin.id)).toMatchObject({
      summary: { text: "edited through remote Pin Studio", tags: ["docs"], detail: true },
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "engine pin body" }] }] },
    });
    const stagedPinImage = stagedPayloads.stage(encodePinStudioStagedPayloadV1({
      schemaVersion: 1,
      mediaType: "image/png",
      name: "engine-pin.png",
      source: "paste",
      dataBase64: Buffer.from("remote Pin Studio image").toString("base64"),
    }));
    expect(await first.invoke("operation-pin-studio-image-0001", {
      schemaVersion: 1,
      method: "pin.studio.apply",
      input: { action: "put-image", payload: stagedPinImage },
    })).toMatchObject({
      status: "ok",
      action: "put-image",
      outcome: "attachment-stored",
      attachment: { kind: "image", name: "engine-pin.png" },
      overSoftLimit: false,
    });
    expect(fs.existsSync(path.join(stagedPayloads.directory, stagedPinImage.token))).toBe(false);

    const stagedSave = stagedPayloads.stage(encodeTaskStudioStagedPayloadV1({
      schemaVersion: 1,
      patch: {
        title: "edited through remote Task Studio",
        deps: [],
        artifact_refs: [],
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "engine studio body" }] }] },
        attachments: [seedImage],
        bodyBaseline: seedTask.body,
        dirty: { title: true },
        docDirty: true,
        expectUpdatedAt: seedTask.updatedAt,
      },
    }));
    const saveStudioCommand = {
      schemaVersion: 1 as const,
      method: "task.studio.apply" as const,
      input: { taskId: seedTask.id, action: "save" as const, payload: stagedSave },
    };
    const savedStudio = await first.invoke("operation-task-studio-save-0001", saveStudioCommand);
    expect(savedStudio).toEqual({
      schemaVersion: 1,
      method: "task.studio.apply",
      status: "ok",
      action: "save",
      outcome: "saved",
    });
    expect(fs.existsSync(path.join(stagedPayloads.directory, stagedSave.token))).toBe(false);
    // Exact replay is resolved by the operation registry before the already-consumed payload is touched.
    expect(await first.invoke("operation-task-studio-save-0001", saveStudioCommand)).toEqual(savedStudio);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "tasks");
    expect(seedTaskStore.get(seedTask.id)).toMatchObject({
      title: "edited through remote Task Studio",
      body: "engine studio body",
    });
    const savedStudioView = await first.query({ schemaVersion: 1, method: "task.studio", input: { id: seedTask.id } });
    expect(savedStudioView).toMatchObject({
      status: "ok",
      view: { studio: { title: "edited through remote Task Studio", anchor: "load" } },
    });

    const stagedImage = stagedPayloads.stage(encodeTaskStudioStagedPayloadV1({
      schemaVersion: 1,
      mediaType: "image/png",
      name: "engine-studio.png",
      source: "paste",
      dataBase64: Buffer.from("remote Task Studio image").toString("base64"),
    }));
    const storedImage = await first.invoke("operation-task-studio-image-0001", {
      schemaVersion: 1,
      method: "task.studio.apply",
      input: { taskId: seedTask.id, action: "put-image", payload: stagedImage },
    });
    expect(storedImage).toMatchObject({
      status: "ok",
      action: "put-image",
      outcome: "attachment-stored",
      attachment: { kind: "image", name: "engine-studio.png" },
      overSoftLimit: false,
    });
    expect(fs.existsSync(path.join(stagedPayloads.directory, stagedImage.token))).toBe(false);

    const notePrototype = {
      schemaVersion: 1 as const,
      method: "task.prototype.review" as const,
      input: {
        taskId: seedTask.id,
        prototypeId: seedRevision.id,
        action: "note" as const,
        expectUpdatedAt: seedPrototype.updatedAt!,
        review: "reviewed through daemon",
      },
    };
    expect(await first.invoke("operation-prototype-note-0001", notePrototype))
      .toEqual({ schemaVersion: 1, method: "task.prototype.review", status: "ok" });
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "tasks");
    const notedPrototype = new TaskPrototypeStore(workspaceRoot, seedTask.id).read();
    const approvePrototype = {
      schemaVersion: 1 as const,
      method: "task.prototype.review" as const,
      input: {
        taskId: seedTask.id,
        prototypeId: seedRevision.id,
        action: "approve" as const,
        expectUpdatedAt: notedPrototype.updatedAt!,
        review: "approved through daemon",
      },
    };
    const approved = await first.invoke("operation-prototype-review-0001", approvePrototype);
    expect(approved).toEqual({ schemaVersion: 1, method: "task.prototype.review", status: "ok" });
    expect(await first.invoke("operation-prototype-review-0001", approvePrototype)).toEqual(approved);
    expect(seedTaskStore.get(seedTask.id).awaitingHuman).toBeUndefined();
    expect(new TaskPrototypeStore(workspaceRoot, seedTask.id).read().approved).toMatchObject({
      id: seedRevision.id,
      state: "approved",
      approvedBy: "human",
    });
    const approvedDetail = await first.query({ schemaVersion: 1, method: "task.detail", input: { id: seedTask.id } });
    expect(approvedDetail).toMatchObject({
      status: "ok",
      view: { detail: { prototypes: { prototypes: [{ id: seedRevision.id, state: "approved" }] } } },
    });
    const stagedPrototype = stagedPayloads.stage(encodeTaskStudioStagedPayloadV1({
      schemaVersion: 1,
      title: "engine-studio.html",
      html: "<main>imported through remote Task Studio</main>",
    }));
    expect(await first.invoke("operation-task-studio-prototype-0001", {
      schemaVersion: 1,
      method: "task.studio.apply",
      input: { taskId: seedTask.id, action: "import-prototype", payload: stagedPrototype },
    })).toMatchObject({ status: "ok", action: "import-prototype", outcome: "prototype-imported" });
    expect(fs.existsSync(path.join(stagedPayloads.directory, stagedPrototype.token))).toBe(false);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "tasks");
    expect(new TaskPrototypeStore(workspaceRoot, seedTask.id).read().prototypes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: "engine-studio.html", state: "draft" })]));
    seedTask = seedTaskStore.get(seedTask.id);
    const updateTask = {
      schemaVersion: 1 as const,
      method: "task.update" as const,
      input: { id: seedTask.id, patch: { status: "triaged" as const, expect: { status: "inbox" as const, updatedAt: seedTask.updatedAt } } },
    };
    const updatedTask = await first.invoke("operation-task-update-0001", updateTask);
    expect(updatedTask).toEqual({ schemaVersion: 1, method: "task.update", status: "ok" });
    expect(await first.invoke("operation-task-update-0001", updateTask)).toEqual(updatedTask);
    const updatedBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveAdhocAgents: [] } });
    if (updatedBoard.status !== "ok" || updatedBoard.method !== "task.board") throw new Error("unexpected board result");
    const updatedAt = updatedBoard.view.board.views[0]?.task.updatedAt;
    expect(updatedBoard.view.board.views[0]?.task.status).toBe("triaged");
    if (!updatedAt) throw new Error("updated task timestamp is missing");
    expect(await first.invoke("operation-task-reorder-0001", {
      schemaVersion: 1,
      method: "task.reorder-lane",
      input: { status: "triaged", orderedIds: [seedTask.id], expect: { [seedTask.id]: updatedAt } },
    })).toMatchObject({ status: "ok", method: "task.reorder-lane" });
    expect(await first.invoke("operation-validation-close-0001", {
      schemaVersion: 1,
      method: "validation.close",
      input: { id: seedValidation.id, outcome: "passed", result_note: "installed dogfood passed" },
    })).toMatchObject({ status: "ok", method: "validation.close" });
    const closedBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveAdhocAgents: [] } });
    expect(closedBoard).toMatchObject({ status: "ok", view: { board: { validations: { pendingCount: 0, items: [] } } } });

    const beforeInvalidStudio = fs.readFileSync(configPath, "utf8");
    const invalidStudio = await first.invoke("operation-studio-invalid-0001", {
      schemaVersion: 1,
      method: "studio.submit",
      input: { state: { ...blankCommandFields(), name: "", cmd: "npm test" } },
    });
    expect(invalidStudio).toMatchObject({ method: "studio.submit", status: "ok", truncated: false });
    if (invalidStudio.method !== "studio.submit" || invalidStudio.status !== "ok") throw new Error("unexpected Studio result");
    expect(invalidStudio.errors).toEqual([expect.stringMatching(/name/i)]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeInvalidStudio);

    const createStudioCommand = {
      schemaVersion: 1 as const,
      method: "studio.submit" as const,
      input: { state: { ...blankCommandFields(), name: "lint", cmd: "npm run lint" } },
    };
    const createdStudio = await first.invoke("operation-studio-create-0001", createStudioCommand);
    expect(createdStudio).toEqual({ schemaVersion: 1, method: "studio.submit", status: "ok", errors: [], truncated: false });
    expect(await first.invoke("operation-studio-create-0001", createStudioCommand)).toEqual(createdStudio);
    expect(fs.readFileSync(configPath, "utf8")).toContain("lint:");
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "commands");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: false }] } },
    });

    const startCommand = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const started = await first.invoke("operation-engine-start-0001", startCommand);
    expect(started).toEqual({ schemaVersion: 1, method: "agent.start", status: "ok" });
    expect(await first.invoke("operation-engine-start-0001", startCommand)).toEqual(started);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: true }] } },
    });
    expect(await first.invoke("operation-engine-restart-0001", {
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker" },
    })).toMatchObject({ status: "ok", method: "agent.restart" });
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: true }] } },
    });
    expect(await first.invoke("operation-engine-kill-0001", {
      schemaVersion: 1,
      method: "agent.kill",
      input: { agent: "worker" },
    })).toMatchObject({ status: "ok", method: "agent.kill" });
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: false }] } },
    });

    // Model Extension Host replacement: the old shell disappears without owning any engine teardown.
    const replacement = new EngineControlClient({ socketPath, hello: hello(identity, "shell-new") });
    const replacementSession = await replacement.attach();
    expect(replacementSession.engine).toEqual(firstSession.engine);
    expect((await replacement.health()).shellCount).toBe(2);
    expect(child.exitCode).toBeNull();

    // The Node watcher and event journal remain operational while shell generations are independent.
    fs.writeFileSync(configPath, config("worker", "observer"), "utf8");
    const changed = await waitForEvent(replacement, (event) =>
      event.kind === "views-changed" && event.payload.view === "commands");
    expect(changed.seq).toBeGreaterThan(initial.seq);
    const refreshed = await replacement.snapshot();
    expect(refreshed.projections.agents).toMatchObject({
      total: 2,
      items: [{ name: "observer" }, { name: "worker" }],
    });

    await first.detach();
    await replacement.detach();
    expect((await replacement.health()).shellCount).toBe(0);
    await expectLoopbackListener(identity.bridge.port);
    expect(child.exitCode).toBeNull();

    await stopChild(child);
    expect(child.exitCode).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(await new TmuxService().hasSession(`tachyon-ctl-${identity.workspaceHash}`)).toBe(false);
  }, 20_000);
});

function config(...agents: string[]): string {
  return `agents:\n${agents.map((name) => `  ${name}:\n    cmd: sh\n    autostart: false\n`).join("")}`;
}

function hello(identity: EngineServiceIdentityV1, shellId: string): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: identity.workspaceRoot,
    workspaceHash: identity.workspaceHash,
    shell: { id: shellId, version: "0.57.0-test", locale: "en" },
    protocol: { min: 1, max: 1 },
    capabilities: [],
    settingsDigest: createHash("sha256").update("settings").digest("hex"),
  };
}

function readReady(child: ChildProcessWithoutNullStreams): Promise<EngineServiceIdentityV1> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`daemon engine readiness timeout: ${errors}`)), 10_000);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`daemon engine exited before ready (${code ?? signal}): ${errors}`));
    };
    child.once("close", onClose);
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("TACHYON_ENGINE_READY ")) continue;
        clearTimeout(timer);
        child.removeListener("close", onClose);
        resolve(JSON.parse(line.slice("TACHYON_ENGINE_READY ".length)) as EngineServiceIdentityV1);
        return;
      }
    });
  });
}

async function waitForEvent(
  client: EngineControlClient,
  predicate: (event: WorkspaceEventV1) => boolean,
): Promise<WorkspaceEventV1> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const batch = await client.events();
    const found = batch.events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("daemon engine event timed out");
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

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
