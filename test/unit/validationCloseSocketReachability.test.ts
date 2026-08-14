/**
 * t-ebde5f — MEASUREMENT against the production validation-close door.
 *
 * This deliberately does not use EngineControlClient. The speaker reads the daemon nonce and writes
 * raw JSON-over-newline to the Unix socket, with no privilege beyond the uid shared by every spawned
 * agent. Its attach hello is self-asserted and no human identity or gesture exists anywhere below.
 *
 * The Bridge `close_validation` door is separate: it supplies the Bridge-resolved caller as the actor
 * and is covered by bridge/validation actor tests. Companion exposes no validation-close route. A
 * direct file edit can forge the record, but bypasses closeRound and therefore is not a caller of the
 * close mechanism measured here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  ENGINE_SHELL_PROTOCOL,
  type EngineControlRequestV1,
  type EngineControlResponseV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { ValidationStore } from "@tachyon/engine/validations/ValidationStore.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";
import { assertNoFleetLeak, isolatedDaemonChildEnv } from "../helpers/isolatedDaemonEnv.js";
import { bundledDaemonFixture } from "../helpers/daemonFixtureBundle.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("t-ebde5f — what a same-uid speaker can claim through validation.close", () => {
  it("closes without a human gesture and records only the control-socket channel", async () => {
    const daemon = await startDaemon();
    const store = new ValidationStore(daemon.workspaceRoot);
    const validation = await store.create({
      title: "Human installation check",
      author: "requesteragent",
      executor: "human",
    });

    const speaker = await attach(daemon, "shell-not-an-extension-host");
    const response = await speaker.invoke("validation-close-0001", {
      schemaVersion: 1,
      method: "validation.close",
      input: {
        id: validation.id,
        outcome: "passed",
        result_note: "raw socket speaker supplied this note",
      },
    });

    expect(response).toMatchObject({ ok: true, op: "invoke" });
    expect((response as { result: { status: string } }).result.status).toBe("ok");

    const closed = store.get(validation.id);
    expect(closed.status).toBe("closed");
    expect(closed.rounds.at(-1)?.result_note).toBe("raw socket speaker supplied this note");
    // The daemon knows this door, not the actor. No VS Code process or human participated, so the
    // structured provenance says exactly that instead of turning the self-asserted hello into identity.
    expect(closed.rounds.at(-1)?.closedBy).toEqual({
      kind: "unattributed",
      name: "engine-control",
    });
  }, 120_000);
});

interface Daemon {
  workspaceRoot: string;
  socketPath: string;
  identity: EngineServiceIdentityV1;
}

interface Speaker {
  invoke(operationId: string, command: unknown): Promise<EngineControlResponseV1>;
}

async function attach(daemon: Daemon, shellId: string): Promise<Speaker> {
  const hello: EngineShellHelloV1 = {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: daemon.identity.workspaceRoot,
    workspaceHash: daemon.identity.workspaceHash,
    shell: { id: shellId, version: "0.0.0-not-vscode", locale: "en" },
    protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
    capabilities: [],
    settingsDigest: createHash("sha256").update("anything").digest("hex"),
  };
  const attached = await rawRequest(daemon.socketPath, {
    schemaVersion: 1,
    op: "attach",
    workspaceHash: daemon.identity.workspaceHash,
    hello,
  });
  if (!attached.ok || attached.op !== "attach") throw new Error(`attach refused: ${JSON.stringify(attached)}`);
  const sessionToken = attached.session.sessionToken;
  return {
    invoke: (operationId, command) => rawRequest(daemon.socketPath, {
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: daemon.identity.workspaceHash,
      shellId,
      sessionToken,
      operationId,
      command,
    } as EngineControlRequestV1),
  };
}

function rawRequest(socketPath: string, request: EngineControlRequestV1): Promise<EngineControlResponseV1> {
  const controlNonce = fs.readFileSync(`${socketPath}.nonce`, "utf8").trim();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("control request timed out"))), 30_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, controlNonce })}\n`));
    socket.on("data", (chunk: string) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      finish(() => resolve(JSON.parse(output.slice(0, newline)) as EngineControlResponseV1));
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("end", () => finish(() => reject(new Error("control connection ended without a response"))));
  });
}

async function startDaemon(): Promise<Daemon> {
  const root = makeSocketTemp("tachyon-validation-socket-");
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
  fs.writeFileSync(path.join(workspaceRoot, "tachyon.yml"), "agents: {}\n", "utf8");
  const childEnv = isolatedDaemonChildEnv(tmuxChildEnv(), {
    TMUX_TMPDIR: tmuxTmp,
    TACHYON_ENGINE_TMUX_TMPDIR: tmuxTmp,
    XDG_RUNTIME_DIR: xdgRuntime,
  });
  assertNoFleetLeak(childEnv);
  const socketPath = path.join(runtimeRoot, "engine.sock");
  const worker = bundledDaemonFixture("daemonEngineServiceWorker.ts");
  const child = spawn(process.execPath, [worker, workspaceRoot, storageRoot, mediaRoot, socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  children.push(child);
  return { workspaceRoot, socketPath, identity: await readReady(child) };
}

function readReady(child: ChildProcessWithoutNullStreams): Promise<EngineServiceIdentityV1> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`daemon readiness timeout: ${stderr}`)), 90_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("TACHYON_ENGINE_READY ")) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line.slice("TACHYON_ENGINE_READY ".length)) as EngineServiceIdentityV1);
        return;
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early (${code}): ${stderr}`));
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000).unref?.();
  });
}
