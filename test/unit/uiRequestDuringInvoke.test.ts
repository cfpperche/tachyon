import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startEngineControlServer, type RunningEngineControlServer } from "../../src/engine-service/controlServer.js";
import type { StagedEngineBundle, StagedEngineRuntime } from "../../src/engine-service/engineBundleStore.js";
import {
  ENGINE_SHELL_PROTOCOL,
  workspaceCommandSuccessV1,
  type EngineServiceIdentityV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "../../src/engine-service/protocol.js";
import { connectRemoteWorkspaceClient } from "../../src/shell/WorkspaceClient.js";
import { ENGINE_UI_CAPABILITY } from "../../src/engine-service/uiRequestBroker.js";
import { workspaceHash } from "../../src/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";

/**
 * t-5ca73a — the deadlock that made every "Review" button on a notice do nothing.
 *
 * Reported symptom: the attention arrives, the human clicks Review, the notice disappears and no
 * screen opens. Ten seconds later the engine journal records `ui-unavailable` for a perfectly
 * well-formed `tachyon.openHumanInbox` request. The command existed, the args were right, the target
 * accepted them — nothing along the way was broken.
 *
 * What is broken is the SHAPE. Invoking a notice action is a control call (`invoke`), and the engine
 * awaits the action. The action asks the shell to open a window, which parks a request in the pull-model
 * broker and waits for a shell to claim it. But the only place the shell claims is inside `sync()`, and
 * `sync()` is chained on the same `this.tail` the in-flight `invoke` occupies. So the shell blocks
 * waiting for a request that only the shell can service, until the broker's 10s timeout ends it.
 *
 * `openTask` — the "Open" button on a task notice, which the human observed WORKING — escapes by pure
 * accident: it fires the same request and does not await it, so `invoke` returns and the tail unblocks
 * before the next poll. Same transport, same broker, same command kind. One awaits, one does not.
 *
 * This is why the guard belongs at the client: the fix must hold for an action that DOES await, or the
 * next `await host.executeCommand(...)` inside a notice action rebuilds the deadlock with no test
 * standing in its way.
 */

const roots: string[] = [];
const servers: RunningEngineControlServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("t-5ca73a — a UI request raised INSIDE a control call still reaches the shell", () => {
  it("services the request while `invoke` is still in flight, instead of deadlocking against it", async () => {
    const root = temp("tachyon-ui-during-invoke-");
    const workspaceRoot = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspaceRoot, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const socketPath = path.join(runtimeRoot, "control.sock");
    const canonicalRoot = fs.realpathSync(workspaceRoot);
    const engineIdentity = identity(canonicalRoot, "engine-ui", "bridge-ui");

    const opened: string[] = [];
    let server!: RunningEngineControlServer;

    server = await startEngineControlServer({
      socketPath,
      identity: engineIdentity,
      getSnapshot: () => snapshot(engineIdentity, 0, "initial"),
      // The notice action, in the exact shape DaemonEngineHost.executeCommand has: raise a UI request
      // and AWAIT its result before the control call can return. This is `invokeNoticeAction` →
      // `await action()` → `host.executeCommand("tachyon.openHumanInbox", …)`.
      invoke: async (command) => {
        await server.requestUi({
          schemaVersion: 1,
          operationId: "11111111-2222-4333-8444-555555555555",
          kind: "execute-command",
          command: "tachyon.openHumanInbox",
          args: ["b349073a", { kind: "saved-agent-proposal", id: "sp-4ea3d2" }],
        });
        return workspaceCommandSuccessV1(command);
      },
      // A tenth of production's window: the point is that the claim must not need the timeout to
      // happen at all, and a real 10s wait would only make this test slow to fail.
      uiRequestTimeoutMs: 1_000,
    });
    servers.push(server);

    const client = await connectRemoteWorkspaceClient({
      workspaceRoot,
      bundle: dummyBundle(root),
      runtime: dummyRuntime(root),
      shell: { id: "shell-ui-during-invoke", version: "0.57.0-test", locale: "en" },
      capabilities: [ENGINE_UI_CAPABILITY],
      uiHandler: async (request) => {
        if (request.kind === "execute-command") opened.push(request.command);
        return null;
      },
      ensure: async () => ({ identity: engineIdentity, controlSocketPath: socketPath, disposition: "reused-exact" }),
    });

    // The human clicks Review. Nothing awaits this yet — the shell's own 1s poll is what has to get
    // the request serviced, exactly as in production.
    // Any command reproduces this — the deadlock is in the CHAINING, not in what was invoked. The
    // production trigger is `sidebar.mutate` / `notice.invoke`, which lands in `invokeNoticeAction`.
    const clicked = client.invoke("operation-notice-invoke-0001", {
      schemaVersion: 1,
      method: "agent.start",
      input: { agent: "worker" },
    });

    // Drive the poll the extension host drives (extension.ts: setTimeout(() => void poll(), 1_000)).
    const poll = setInterval(() => { void client.sync(20).catch(() => undefined); }, 20);
    try {
      await expect(clicked).resolves.toMatchObject({ status: "ok" });
    } finally {
      clearInterval(poll);
      await client.close();
    }

    expect(opened).toEqual(["tachyon.openHumanInbox"]);
  });
});

function identity(workspaceRoot: string, instanceId: string, bridgeInstanceId: string): EngineServiceIdentityV1 {
  return {
    schemaVersion: 1,
    workspaceRoot,
    workspaceHash: workspaceHash(workspaceRoot),
    instanceId,
    pid: process.pid,
    processStartIdentity: `linux:test:${instanceId}`,
    startedAt: new Date().toISOString(),
    bundleId: "a".repeat(64),
    engineVersion: "0.57.0-test",
    protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
    bridge: { instanceId: bridgeInstanceId, port: 43_001 },
  };
}

function snapshot(identity: EngineServiceIdentityV1, seq: number, marker: string): WorkspaceSnapshotEnvelopeV1 {
  return {
    schemaVersion: 1,
    engineInstanceId: identity.instanceId,
    seq,
    projections: {
      marker,
      workspace: {
        root: identity.workspaceRoot,
        hash: identity.workspaceHash,
        folderName: path.basename(identity.workspaceRoot),
        configValid: true,
        configFailure: null,
      },
      bridge: {
        instanceId: identity.bridge.instanceId,
        port: identity.bridge.port,
        url: `http://127.0.0.1:${identity.bridge.port}/mcp`,
        direct: true,
      },
      agents: { total: 0, truncated: false, items: [] },
    },
  };
}

function dummyBundle(root: string): StagedEngineBundle {
  return {
    bundleId: "a".repeat(64),
    root,
    entrypoint: path.join(root, "engine.cjs"),
    manifestPath: path.join(root, "engine-manifest.json"),
    reused: true,
  };
}

function dummyRuntime(root: string): StagedEngineRuntime {
  const runtimeRoot = path.join(root, "engine-runtime", "b".repeat(64));
  return {
    runtimeId: "b".repeat(64),
    root: runtimeRoot,
    executable: path.join(runtimeRoot, "node"),
    manifestPath: path.join(runtimeRoot, "runtime-manifest.json"),
    reused: true,
  };
}

function temp(prefix: string): string {
  const root = makeSocketTemp(prefix);
  roots.push(root);
  return root;
}
