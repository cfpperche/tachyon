import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import { StagedPayloadStore } from "../../src/engine-service/stagedPayloadStore.js";
import { ENGINE_SHELL_PROTOCOL, type EngineServiceIdentityV1, type EngineShellHelloV1, type WorkspaceEventV1 } from "../../src/engine-service/protocol.js";
import { encodePinStudioStagedPayloadV1 } from "../../src/runtime-api/pinStudioCommands.js";
import { encodeTaskStudioStagedPayloadV1 } from "../../src/runtime-api/taskStudioCommands.js";
import { PinStore } from "../../src/pins/PinStore.js";
import {
  TmuxService,
  isolatedArgs,
  sessionName,
  utf8LocaleEnv,
  workspaceHash,
  type ExecResult,
  type PaneSnapshot,
} from "../../src/tmux/TmuxService.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";
import { assertNoFleetLeak, isolatedDaemonChildEnv } from "../helpers/isolatedDaemonEnv.js";
import { bundledDaemonFixture } from "../helpers/daemonFixtureBundle.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

/**
 * t-70fda0 — `agent.start` for the codex `worker` materializes a real harness home and fails hard
 * when host credentials are absent (`no credentials at …/.codex/auth.json`). Same disease as
 * t-eccb00: environment must become a named skip, not an assertion failure that looks like a
 * regression. Classify BEFORE the body runs; never rewrite the report afterwards.
 */
/**
 * t-a12966 — the codex credential these cases need is SUBSTRATE: the harness materializer links a
 * credential file so the spawn can proceed, and nothing below launches a real runtime. Listing the
 * titles here for `skipTestsWithoutOptionalRuntimeAuth` made the result depend on whether the HOST was
 * logged in — measured green on the maintainer's checkout and pending in every agent worktree with a
 * private, credential-free config home. Injected through the door production reads instead.
 */
useDisposableRuntimeAuth(["codex"]);

/** t-c289cf — real tmux ops against the daemon's private TMUX_TMPDIR (never production -L tachyon). */
function tmuxExecutorForEnv(env: NodeJS.ProcessEnv): (args: string[]) => Promise<ExecResult> {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "tmux",
        isolatedArgs(args),
        { encoding: "utf8", env: { ...env, ...utf8LocaleEnv(env) } },
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve({ stdout, stderr });
        },
      );
    });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});


/**
 * t-eee876 — assert an envelope's SUCCESS in a way that survives being wrong.
 *
 * `toEqual({schemaVersion, method, status: "ok"})` on a real operation reads well and reports badly:
 * the error envelope carries `code` and `message` too, so a genuine failure surfaced as
 * "expected { schemaVersion: 1, …(4) } to deeply equal { schemaVersion: 1, …(2) }" — a key COUNT,
 * with the two fields that explain what happened discarded by the matcher. That cost a real
 * `agent.start` failure under load being read as a shape problem.
 *
 * Assert the status first, carrying the message, then the shape.
 */
function expectOk(envelope: unknown, method: string, extra: Record<string, unknown> = {}): void {
  const e = envelope as { status?: string; code?: string; message?: string };
  expect(e?.status, `${method} failed: ${e?.code ?? "?"} — ${e?.message ?? "no message"}`).toBe("ok");
  expect(envelope).toEqual({ schemaVersion: 1, method, status: "ok", ...extra });
}

/**
 * t-29962c — the same lesson, for the `toMatchObject` assertions.
 *
 * `toMatchObject({status:"ok", …})` on an error envelope reports
 * "expected { schemaVersion: 1, …(4) } to match object { status: 'ok', …(2) }" and then prints
 * `+ "status": "error"` with `code` and `message` collapsed into "(4 matching properties omitted)".
 * That is exactly the report this task was opened on: the flake was legible as a *shape* mismatch
 * for three weeks while the envelope was carrying the reason the whole time.
 */
function expectOkMatching(envelope: unknown, label: string, shape: Record<string, unknown>): void {
  const e = envelope as { status?: string; code?: string; message?: string };
  expect(e?.status, `${label} failed: ${e?.code ?? "?"} — ${e?.message ?? "no message"}`).toBe("ok");
  expect(envelope).toMatchObject(shape);
}

describe("daemon engine service", () => {
  it("owns a real Workspace and direct Bridge across shell replacement and no-shell time", async () => {
    const root = makeSocketTemp("tachyon-engine-service-");
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const storageRoot = path.join(root, "storage");
    const mediaRoot = path.join(root, "bundle");
    const runtimeRoot = path.join(root, "runtime");
    const tmuxTmp = path.join(root, "tmux-tmp");
    const xdgRuntime = path.join(root, "xdg-runtime");
    for (const directory of [workspaceRoot, storageRoot, mediaRoot, runtimeRoot, tmuxTmp, xdgRuntime]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    // t-c289cf: private tmux + XDG so parallel verify:full never hits production -L tachyon or shared runtime.
    // t-70fda0 / t-93ec7f: strip ambient fleet TACHYON_* via the shared helper so a live Bridge token
    // never reaches the fixture; reintroduce only the private tmux pointer the daemon needs.
    const childEnv = isolatedDaemonChildEnv(tmuxChildEnv(), {
      TMUX_TMPDIR: tmuxTmp,
      TACHYON_ENGINE_TMUX_TMPDIR: tmuxTmp,
      XDG_RUNTIME_DIR: xdgRuntime,
    });
    assertNoFleetLeak(childEnv);
    const testBin = path.join(root, "test-bin");
    fs.mkdirSync(testBin, { mode: 0o700 });
    // t-29962c — the fixture runtime MUST answer `--version` and exit. `runtime-ops.view` probes
    // `<runtime> --version` (src/runtimeOps/snapshotService.ts:401) with a 10_000ms timeout, and a
    // bare `exec sh` DROPS the argument and then blocks reading execFile's still-open stdin pipe —
    // so the probe burned the whole timeout. Measured: that single query was 10.4s of this test's
    // ~15s, against the test's own 20_000ms cap. ~5s of headroom for a 16-worker gate is not
    // headroom, and it is the second reason this file flaked. Answering costs ~5ms; the agent pane
    // still gets its interactive shell from the `exec sh` below.
    fs.writeFileSync(
      path.join(testBin, "codex"),
      "#!/bin/sh\ncase \"$1\" in --version) echo 'codex 0.0.0-fixture'; exit 0 ;; esac\nexec sh\n",
      { mode: 0o700 },
    );
    childEnv.PATH = `${testBin}:${childEnv.PATH ?? process.env.PATH ?? ""}`;
    const isolatedTmux = new TmuxService(tmuxExecutorForEnv(childEnv));
    const configPath = path.join(workspaceRoot, "tachyon.yml");
    fs.writeFileSync(configPath, "agents: {}\nterminals:\n  bootstrap:\n    cmd: sh\nsettings:\n  delivery:\n    mode: legacy\n    handoffSafety: disabled\n", "utf8");
    const promptBody = "printf 'prompt-once\\n' >> .tachyon-prompt-proof";
    const promptSha256 = createHash("sha256").update(promptBody, "utf8").digest("hex");
    const promptDir = path.join(workspaceRoot, ".tachyon", "prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, "persistent-check.md"), `---\ntitle: Persistent check\n---\n${promptBody}\n`, "utf8");
    const seedTaskStore = new TaskStore(workspaceRoot);
    let seedTask = await seedTaskStore.create({
      id: "t-abc123",
      title: "remote Board",
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
    const seedPin = await seedPinStore.create("remote Pin Studio", "human", { tags: ["ui"] });
    const socketPath = path.join(runtimeRoot, "engine.sock");
    const worker = bundledDaemonFixture("daemonEngineServiceWorker.ts");
    const child = spawn(process.execPath, [worker, workspaceRoot, storageRoot, mediaRoot, socketPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
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
    const createdWorker = await first.invoke("operation-agent-profile-create-worker-0001", canonicalAgentCreate("worker"));
    expect(createdWorker.status, JSON.stringify(createdWorker)).toBe("ok");
    if (createdWorker.status !== "ok" || createdWorker.method !== "extension.invoke"
      || !createdWorker.value || typeof createdWorker.value !== "object" || Array.isArray(createdWorker.value)
      || typeof createdWorker.value.revision !== "string") throw new Error("unexpected canonical profile create result");
    expect(await first.invoke("operation-agent-profile-enable-worker-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: {
        action: "agent-profile.studio-lifecycle",
        mutation: {
          schemaVersion: 1,
          operation: "set-enabled",
          agentName: "worker",
          expectedRevision: createdWorker.value.revision,
          enabled: true,
        },
      },
    })).toMatchObject({ status: "ok", action: "agent-profile.studio-lifecycle" });
    expect(await first.invoke("operation-bootstrap-terminal-delete-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "config.agent.delete", agent: "bootstrap", removeWorktree: false },
    })).toMatchObject({ status: "ok", action: "config.agent.delete" });
    const initial = await first.snapshot();
    expect(initial.projections).toMatchObject({
      workspace: { root: identity.workspaceRoot, hash: identity.workspaceHash, configValid: true },
      bridge: { port: identity.bridge.port, instanceId: identity.bridge.instanceId, direct: true },
      agents: { total: 1, truncated: false, items: [{ name: "worker", lifetime: "saved", running: false }] },
    });
    const doctorReport = await first.query({ schemaVersion: 1, method: "extension.query", input: { action: "doctor.report" } });
    expect(doctorReport).toMatchObject({
        status: "ok",
        action: "doctor.report",
        value: {
          text: expect.stringMatching(/ignored or deprecated config setting.*settings\.delivery was ignored/is),
        },
      });
    if (doctorReport.status === "ok" && doctorReport.method === "extension.query" && doctorReport.action === "doctor.report") {
      expect((doctorReport.value as { hasErrors: boolean; text: string }).hasErrors, (doctorReport.value as { text: string }).text).toBe(false);
    }
    expect(await first.query({ schemaVersion: 1, method: "probe.view", input: { caller: "worker" } }))
      .toEqual({
        schemaVersion: 1,
        method: "probe.view",
        status: "ok",
        view: { rows: [], total: 0, running: 0, completed: 0, failed: 0, empty: true, caller: "worker" },
      });
    expect(await first.query({ schemaVersion: 1, method: "activity.context", input: { agent: "worker" } }))
      .toEqual({
        schemaVersion: 1,
        method: "activity.context",
        status: "ok",
        view: {
          schemaVersion: 1,
          context: {
            schemaVersion: 1,
            agent: "worker",
            sharedCwd: false,
            attention: null,
            targets: { total: 0, truncated: false, items: [] },
          },
        },
      });

    expect(await first.query({ schemaVersion: 1, method: "sidebar.view", input: {} })).toMatchObject({
      method: "sidebar.view",
      status: "ok",
      view: {
        fleet: {
          folder: { hash: identity.workspaceHash, name: "workspace" },
          bridge: { port: String(identity.bridge.port), connected: true },
          agents: [{ name: "worker", status: "stopped" }],
          pins: [{ id: seedPin.id, text: "remote Pin Studio", done: false, tags: ["ui"] }],
          handoff: { exists: false, pendingCount: 0 },
        },
      },
    });
    expect(await first.query({ schemaVersion: 1, method: "runtime-ops.view", input: {} })).toMatchObject({
      method: "runtime-ops.view",
      status: "ok",
      view: {
        schemaVersion: 2,
        summary: { managedAgents: 1 },
        runtimes: expect.any(Array),
        providerCapacity: [
          {
            provider: "codex",
            scope: "provider-account",
            configuration: { state: "disabled" },
            quota: { state: "unavailable", reason: "source-disabled" },
          },
          {
            provider: "claude",
            scope: "provider-account",
            configuration: { state: "disabled" },
            quota: { state: "unavailable", reason: "source-disabled" },
          },
        ],
      },
    });
    const toggleSidebarPin = {
      schemaVersion: 1 as const,
      method: "sidebar.mutate" as const,
      input: { action: "pin.toggle" as const, id: seedPin.id, done: true },
    };
    const toggledSidebarPin = await first.invoke("operation-sidebar-pin-toggle-0001", toggleSidebarPin);
    expect(toggledSidebarPin).toEqual({
      schemaVersion: 1,
      method: "sidebar.mutate",
      status: "ok",
      action: "pin.toggle",
      id: seedPin.id,
      changed: true,
    });
    expect(await first.invoke("operation-sidebar-pin-toggle-0001", toggleSidebarPin)).toEqual(toggledSidebarPin);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "pins");
    expect(await first.query({ schemaVersion: 1, method: "sidebar.view", input: {} })).toMatchObject({
      status: "ok",
      view: { fleet: { pins: [{ id: seedPin.id, done: true }] } },
    });

    const coldHandoff = await first.query({ schemaVersion: 1, method: "handoff.view", input: {} });
    expect(coldHandoff).toMatchObject({
      method: "handoff.view",
      status: "ok",
      view: {
        handoff: {
          canonicalRelativePath: ".tachyon/HANDOFF.md",
          exists: false,
          pendingCount: 0,
          distillTargets: [{ name: "worker", state: "stopped", lifetime: "saved" }],
        },
      },
    });
    const ensureHandoff = {
      schemaVersion: 1 as const,
      method: "handoff.ensure" as const,
      input: {},
    };
    const ensuredHandoff = await first.invoke("operation-handoff-ensure-0001", ensureHandoff);
    expect(ensuredHandoff).toEqual({
      schemaVersion: 1,
      method: "handoff.ensure",
      status: "ok",
      canonicalRelativePath: ".tachyon/HANDOFF.md",
    });
    expect(await first.invoke("operation-handoff-ensure-0001", ensureHandoff)).toEqual(ensuredHandoff);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "handoff");
    expect(fs.readFileSync(path.join(workspaceRoot, ".tachyon", "HANDOFF.md"), "utf8")).toContain("## Current State");
    expect(await first.query({ schemaVersion: 1, method: "handoff.view", input: {} })).toMatchObject({
      status: "ok",
      view: { handoff: { exists: true, updatedBy: "human", revision: expect.stringMatching(/^[a-f0-9]{16}$/) } },
    });

    const initialBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveTemporaryAgents: ["reviewer"] } });
    expect(initialBoard).toMatchObject({
      method: "task.board",
      status: "ok",
      view: {
        board: {
          views: [{ task: { id: seedTask.id, title: "remote Board", body: "engine-owned body", status: "inbox" } }],
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
          task: { id: seedTask.id, title: "remote Board" },
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
          title: "remote Board",
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
      view: {
        studio: {
          pinId: seedPin.id,
          title: "remote Pin Studio",
          tags: ["ui"],
          doc: null,
          attachments: [],
          expectUpdatedAt: seedPin.updatedAt ?? seedPin.createdAt,
        },
      },
    });
    const stagedPinSave = stagedPayloads.stage(encodePinStudioStagedPayloadV1({
      schemaVersion: 1,
      patch: {
        title: "edited through remote Pin Studio",
        tags: ["docs"],
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "engine pin body" }] }] },
        attachments: [],
        docDirty: false,
        expectUpdatedAt: seedPin.updatedAt ?? seedPin.createdAt,
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
    expectOk(approved, "task.prototype.review");
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
    expectOk(updatedTask, "task.update");
    expect(await first.invoke("operation-task-update-0001", updateTask)).toEqual(updatedTask);
    const updatedBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveTemporaryAgents: [] } });
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
    const closedBoard = await first.query({ schemaVersion: 1, method: "task.board", input: { liveTemporaryAgents: [] } });
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
    expectOk(createdStudio, "studio.submit", { errors: [], truncated: false });
    expect(await first.invoke("operation-studio-create-0001", createStudioCommand)).toEqual(createdStudio);
    expect(fs.readFileSync(configPath, "utf8")).toContain("lint:");
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "commands");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: false }] } },
    });

    const extensionAgents = await first.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agents.list" },
    });
    expect(extensionAgents).toMatchObject({
      method: "extension.query",
      status: "ok",
      action: "agents.list",
      value: [{ name: "worker", lifetime: "saved", running: false }],
    });
    const createPin = {
      schemaVersion: 1 as const,
      method: "extension.invoke" as const,
      input: { action: "pin.create" as const, text: "created through extension operations", by: "human", done: true },
    };
    const createdPin = await first.invoke("operation-extension-pin-0001", createPin);
    expect(createdPin).toMatchObject({
      method: "extension.invoke",
      status: "ok",
      action: "pin.create",
      value: { text: "created through extension operations", done: true },
    });
    expect(await first.invoke("operation-extension-pin-0001", createPin)).toEqual(createdPin);
    expect(await first.query({ schemaVersion: 1, method: "extension.query", input: { action: "pins.list" } }))
      .toMatchObject({
        action: "pins.list",
        value: expect.arrayContaining([expect.objectContaining({ text: "created through extension operations", done: true })]),
      });
    expect(await first.query({ schemaVersion: 1, method: "extension.query", input: { action: "worktrees.list" } }))
      .toMatchObject({ action: "worktrees.list", value: { worktrees: [] } });
    expect(await first.query({ schemaVersion: 1, method: "extension.query", input: { action: "prompt.catalog" } }))
      .toMatchObject({
        action: "prompt.catalog",
        value: {
          templates: [{ id: "persistent-check", title: "Persistent check", body: promptBody, sha256: promptSha256 }],
          targets: [],
        },
      });
    expect(await first.invoke("operation-prompt-mismatch-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: {
        action: "prompt.inject",
        agent: "worker",
        templateId: "persistent-check",
        expectedSha256: "0".repeat(64),
        submit: true,
      },
    })).toMatchObject({
      status: "error",
      code: "COMMAND_FAILED",
      message: expect.stringMatching(/changed after preview/),
    });
    expect(await first.invoke("operation-extension-handoff-note-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "handoff.note", summary: "persistent shell provenance", evidence: ["dist/extension.js"] },
    })).toMatchObject({ status: "ok", action: "handoff.note", value: { changed: true } });
    expect(await first.query({ schemaVersion: 1, method: "handoff.view", input: {} }))
      .toMatchObject({ view: { handoff: { notes: [expect.objectContaining({ summary: "persistent shell provenance" })] } } });
    expect(await first.invoke("operation-extension-stop-all-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "workspace.stop-all" },
    })).toMatchObject({ status: "ok", action: "workspace.stop-all", value: { stoppedAgents: expect.any(Number) } });

    // t-72d4d3 — on failure dump private inventory + parent hasSession (disagreement evidence).
    const workerSession = sessionName(identity.workspaceHash, "worker");
    const startCommand = { schemaVersion: 1 as const, method: "agent.start" as const, input: { agent: "worker" } };
    const started = await first.invoke("operation-engine-start-0001", startCommand);
    if ((started as { status?: string }).status !== "ok") {
      const inventory = await isolatedTmux.listSessions("tachyon-").catch((err) => [`list-failed:${String(err)}`]);
      const parentHas = await isolatedTmux.hasSession(workerSession).catch((err) => `err:${String(err)}`);
      const detail = started as { code?: string; message?: string };
      throw new Error(
        `agent.start failed: ${detail.code ?? "?"} — ${detail.message ?? "no message"}; ` +
          `workerSession=${workerSession} parentHasSession=${parentHas} sessions=[${inventory.join(",")}]`,
      );
    }
    expectOk(started, "agent.start");
    expect(await first.invoke("operation-engine-start-0001", startCommand)).toEqual(started);
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: true }] } },
    });
    expect(await first.query({ schemaVersion: 1, method: "extension.query", input: { action: "prompt.catalog" } }))
      .toMatchObject({ value: { targets: [{ name: "worker", description: "running AI agent" }] } });
    expectOkMatching(await first.invoke("operation-prompt-submit-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: {
        action: "prompt.inject",
        agent: "worker",
        templateId: "persistent-check",
        expectedSha256: promptSha256,
        submit: true,
      },
    }), "prompt.inject", {
      status: "ok",
      action: "prompt.inject",
      value: { injected: true, title: "Persistent check", mode: "submit" },
    });
    const agentInput = {
      schemaVersion: 1 as const,
      method: "agent.input" as const,
      input: { agent: "worker", text: "printf 'once\\n' >> .tachyon-agent-input-proof", submit: true },
    };
    const inputSent = await first.invoke("operation-agent-input-0001", agentInput);
    expectOkMatching(inputSent, "agent.input", {
      status: "ok",
      receipt: { status: "submitted" },
    });
    expect(await first.invoke("operation-agent-input-0001", agentInput)).toEqual(inputSent);
    expectOkMatching(await first.invoke("operation-engine-restart-0001", {
      schemaVersion: 1,
      method: "agent.restart",
      input: { agent: "worker" },
    }), "agent.restart", { status: "ok", method: "agent.restart" });
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expect(await first.snapshot()).toMatchObject({
      projections: { agents: { items: [{ name: "worker", running: true }] } },
    });
    const tmuxView = await first.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "tmux.snapshot" },
    });
    expectOkMatching(tmuxView, "tmux.snapshot", { status: "ok", action: "tmux.snapshot", value: expect.any(Array) });
    if (tmuxView.status !== "ok" || tmuxView.method !== "extension.query" || tmuxView.action !== "tmux.snapshot") {
      throw new Error("unexpected tmux snapshot result");
    }
    const workerPane = (tmuxView.value as unknown as PaneSnapshot[])
      .find((row) => row.session.endsWith("-worker"));
    if (!workerPane) throw new Error("worker pane is absent from engine-owned tmux snapshot");
    const expectedPane = {
      session: workerPane.session,
      window: workerPane.window,
      pane: workerPane.pane,
      pid: workerPane.pid,
      startCommand: workerPane.startCommand,
      ...(workerPane.createdAt !== undefined ? { createdAt: workerPane.createdAt } : {}),
    };
    expectOkMatching(await first.invoke("operation-terminal-open-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "terminal.open", agent: "worker", session: workerPane.session },
    }), "terminal.open", {
      status: "ok",
      action: "terminal.open",
      value: { opened: true, session: workerPane.session },
    });
    expectOkMatching(await first.invoke("operation-terminal-close-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "terminal.close", agent: "worker", session: workerPane.session },
    }), "terminal.close", {
      status: "ok",
      action: "terminal.close",
      value: { closed: true, session: workerPane.session },
    });
    expect(await first.invoke("operation-tmux-stale-kill-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "tmux.kill", expected: { ...expectedPane, pid: expectedPane.pid + 1 } },
    })).toMatchObject({ status: "error", code: "COMMAND_FAILED", message: expect.stringMatching(/changed after confirmation/) });
    const directTmux = isolatedTmux;
    expect(await directTmux.hasSession(workerPane.session)).toBe(true);
    expectOkMatching(await first.invoke("operation-tmux-exact-kill-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "tmux.kill", expected: expectedPane },
    }), "tmux.kill", {
      status: "ok",
      action: "tmux.kill",
      value: { killed: true, session: workerPane.session },
    });
    expect(await directTmux.hasSession(workerPane.session)).toBe(false);
    // t-c289cf's ORIGINAL failing line. It reported a key count; now it reports the reason.
    expectOkMatching(
      await first.invoke("operation-engine-start-after-inspector-0001", startCommand),
      "agent.start (after inspector kill)",
      { status: "ok", method: "agent.start" },
    );
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expectOkMatching(await first.invoke("operation-engine-stop-0001", {
      schemaVersion: 1,
      method: "agent.stop",
      input: { agent: "worker" },
    }), "agent.stop", { status: "ok", method: "agent.stop", outcome: "stopped" });
    expectOkMatching(
      await first.invoke("operation-engine-start-after-stop-0001", startCommand),
      "agent.start (after confirmed stop)",
      { status: "ok", method: "agent.start" },
    );
    await waitForEvent(first, (event) => event.kind === "views-changed" && event.payload.view === "agents");
    expectOkMatching(await first.invoke("operation-engine-kill-0001", {
      schemaVersion: 1,
      method: "agent.kill",
      input: { agent: "worker" },
    }), "agent.kill", { status: "ok", method: "agent.kill" });
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
    expect(await replacement.invoke("operation-agent-profile-create-observer-0001", canonicalAgentCreate("observer")))
      .toMatchObject({ status: "ok", action: "agent-profile.studio-commit" });
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
    expect(await isolatedTmux.hasSession(`tachyon-ctl-${identity.workspaceHash}`)).toBe(false);
  }, 20_000);
});

/**
 * t-29962c — `attention: false` is the FIX for the three-week flake, and it is a measurement.
 *
 * This fixture's "codex" is `#!/bin/sh\nexec sh` (see `testBin` above): a bare shell with no runtime
 * chrome for the attention monitor to read. What the monitor produces for it is therefore not an
 * observation, it is the SYNTHETIC seed state — `AttentionMonitor.runTick` creates a fresh agent's
 * snapshot at `state: "working"` (src/attention/AttentionMonitor.ts:447) and cannot leave it before
 * `silenceSec` of pane stability (8s: src/config/loadConfig.ts:32, agentProfileProjection.ts:128),
 * sampled on a 3s grid (ATTENTION_POLL_MS, src/workspace/Workspace.ts:317). `prompt.inject` with
 * `submit: true` refuses while the state is `working` (extensionOperationService.ts:341 →
 * injectFlow.ts:42).
 *
 * So with attention on, this test passed only by OUTRUNNING the daemon's first poll tick: under
 * `verify:full`'s 16 workers the gap between `agent.start` and the injection stretched past 3s, the
 * tick landed, and the injection was refused with `'worker' is working`. Measured, not inferred —
 * inserting a 4s wait before the injection turns the failure from intermittent into 3/3 on an idle
 * machine, and 20 CPU spinners reproduce it at ~1-in-5 with no source change at all.
 *
 * No coverage is lost: with attention on, this test never once observed a monitored state — it only
 * ever won a race against the monitor's existence. The production behaviour that a freshly spawned
 * agent reads `working` for ~10s with no evidence of work is real, still there, and filed separately.
 */
function canonicalAgentCreate(agentName: string) {
  return {
    schemaVersion: 1 as const,
    method: "extension.invoke" as const,
    input: {
      action: "agent-profile.studio-commit" as const,
      mutation: {
        schemaVersion: 1 as const,
        kind: "agent-instance" as const,
        agentName,
        editable: {
          displayName: agentName,
          runtime: { adapter: "codex", executable: "codex" },
          cwd: "",
          lifecycle: { autostart: false, restart: "never" as const, attention: false },
          worktree: { enabled: false, branch: "", setup: [] },
          instructions: "",
          isolation: "" as const,
        },
      },
    },
  };
}

function hello(identity: EngineServiceIdentityV1, shellId: string): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: identity.workspaceRoot,
    workspaceHash: identity.workspaceHash,
    shell: { id: shellId, version: "0.57.0-test", locale: "en" },
    protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
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
