/**
 * t-6edd70 — MEASUREMENT, against the production door.
 *
 * The task was found by READING code. This file reproduces it instead, and it deliberately does NOT
 * use `EngineControlClient`: every request below is raw JSON-over-newline written straight into the
 * daemon's unix socket by a process whose ONLY privilege is being the same uid — exactly what any
 * agent Tachyon spawns is. The nonce is read off `<socket>.nonce` the same way, by hand.
 *
 * Two questions are measured here, and both answers are assertions rather than prose:
 *
 *  (a) can a socket speaker resolve a pending human-approval request it does not own, and what does
 *      the durable record say about who resolved it?
 *  (b) is the studio target's METHOD surface reachable by a socket speaker, or only the named-ACTION
 *      surface? This decides whether removing an action from `EXTENSION_COMMAND_ACTIONS` protects
 *      anything at all (t-93ac7f asked the same question and left it unmeasured).
 *
 * These are CHARACTERIZATION tests: they pin what the product does today, including the defect. When
 * the defect is fixed, the assertions marked DEFECT below must be inverted, and their failure at that
 * moment is the point — a silent pass would mean the fix changed nothing on this door.
 *
 * t-86e59a did exactly that to half of question (a), and the half it did NOT touch matters more. The
 * record no longer credits `"vscode"` for a resolution nobody in VS Code performed; it names the CHANNEL
 * instead. The DOOR is untouched — a same-uid speaker still resolves an approval it does not own, with
 * no human anywhere on the path. That is the capability fix (uid/sandbox isolation, t-5313dc) and it is
 * open. Read the DEFECT marks below as "this door is still measured open", not as "this is unfixed
 * prose": the day t-5313dc lands, the reachability assertions go red and this file is the proof.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ENGINE_SHELL_PROTOCOL,
  type EngineControlRequestV1,
  type EngineControlResponseV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
} from "../../src/engine-service/protocol.js";
import { EXTENSION_COMMAND_ACTIONS } from "../../src/runtime-api/extensionOperations.js";
import {
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  buildApprovalRequest,
  readApprovalRequest,
  writeApprovalRequest,
} from "../../src/bridge/approvalRequest.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";
import { assertNoFleetLeak, isolatedDaemonChildEnv } from "../helpers/isolatedDaemonEnv.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("t-6edd70 — what a same-uid control-socket speaker can reach", () => {
  it("DEFECT: resolves a pending approval it did not request — no human anywhere on the path", async () => {
    const daemon = await startDaemon();
    // Written the way the Bridge writes it: `requester` is the Bridge-resolved caller and cannot be
    // self-declared. That identity survives on the record — and is never consulted at resolve time.
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "needs a human to authorize removing a safety guard",
      proposedAction: "remove the guard",
      risk: "high",
      exactPrompt: "may I remove it?",
      id: "a-aaa111",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    writeApprovalRequest(daemon.workspaceRoot, request);
    expect(readApprovalRequest(daemon.workspaceRoot, "a-aaa111").status).toBe("pending");

    const speaker = await attach(daemon, "shell-not-an-extension-host");
    const response = await speaker.invoke("operation-approval-resolve-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "approval.resolve", id: "a-aaa111", decision: "approved" },
    });

    // DEFECT (a): the nonce alone carries this. No caller identity is consulted anywhere on the path.
    expect(response).toMatchObject({ ok: true, op: "invoke" });
    expect((response as { result: { status: string } }).result.status).toBe("ok");

    const resolved = readApprovalRequest(daemon.workspaceRoot, "a-aaa111");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.decision).toBe("approved");
    // DEFECT (a) IS STILL OPEN — this door resolves, and nothing here required a human. What changed
    // (t-86e59a) is only the AGGRAVATING half. `resolvedBy` used to be the server-side constant
    // `"vscode"`, so a resolution nobody in VS Code performed was recorded as if the editor had
    // performed it and a human auditing this record read their own name. It now names the CHANNEL the
    // resolution came through, which is the one thing this call site actually knows about itself.
    //
    // The DEFECT mark stays because the capability did not change: closing this door is t-5313dc, and
    // the assertion above — an approval resolved by a speaker holding nothing but same-uid — is what
    // keeps that open finding measured rather than remembered.
    expect(resolved.resolution?.resolvedBy).toBe(APPROVAL_CHANNEL_VSCODE_COMMAND);
    expect(resolved.resolution?.resolvedBy).not.toBe("vscode");

    // The witness ledger repeats the value, so whatever is recorded is durable in two places — that is
    // what made the false trail false twice, and it is why both had to change together.
    const witness = fs.readFileSync(path.join(daemon.workspaceRoot, ".tachyon", "approvals.jsonl"), "utf8");
    expect(witness).toContain('"kind":"resolved"');
    expect(witness).toContain(`"by":"${APPROVAL_CHANNEL_VSCODE_COMMAND}"`);
    expect(witness).not.toContain('"by":"vscode"');
  }, 120_000);

  it("the wire surface is the NAMED-ACTION surface — an unlisted method or action is refused by name", async () => {
    const daemon = await startDaemon();
    const speaker = await attach(daemon, "shell-not-an-extension-host");

    // (b) part 1 — the studio target's methods are NOT wire methods. `WorkspaceCommandMethodV1`
    // (protocol.ts:237-256) enumerates every method the daemon decodes; a studio method name is not
    // among them and `isWorkspaceCommandV1` refuses the request before any domain code runs.
    const asMethod = await speaker.invoke("operation-studio-method-0001", {
      schemaVersion: 1,
      // Deliberately ill-typed: the point is what the WIRE accepts, not what the client types allow.
      method: "createSavedAgent",
      input: { agent: "whoever" },
    } as never);
    expect(asMethod).toMatchObject({ ok: false });

    // (b) part 2 — inside `extension.invoke`, only a name in `EXTENSION_COMMAND_ACTIONS` decodes.
    // `savedAgent.approve` is the action the Saved Agent proposal flow would need and does not have.
    expect(EXTENSION_COMMAND_ACTIONS as readonly string[]).not.toContain("savedAgent.approve");
    const asAction = await speaker.invoke("operation-unlisted-action-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "savedAgent.approve", proposalId: "sa-1" },
    } as never);
    expect(asAction).toMatchObject({ ok: false });
  }, 120_000);

  it("DEFECT: the Saved Agent CONTRAST is weaker than it looks — the approval's EFFECT is a named action", async () => {
    const daemon = await startDaemon();
    const speaker = await attach(daemon, "shell-not-an-extension-host");

    // `commitSavedAgentProposal` (extension.ts:1464) redeems a human-approved proposal by calling
    // `ws.createSavedAgent(...)`, which `ClientWorkspaceStudioTarget:202-221` sends as the named action
    // `agent-profile.saved-agent-create-v2` — owner and the `proposeSavedAgent` grant included.
    //
    // So "approve" being absent from the list does not keep an agent away from what approving DOES:
    // the same socket speaker performs the whole effect directly, with no proposal and no human.
    // The owner it names must exist first — also a named action, also reachable from here.
    const owner = await speaker.invoke("operation-owner-create-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: { action: "agent-profile.studio-commit", mutation: agentInstanceMutation("requesteragent") },
    } as never);
    expect((owner as { result: { status: string } }).result.status, JSON.stringify(owner)).toBe("ok");

    const created = await speaker.invoke("operation-saved-agent-create-0001", {
      schemaVersion: 1,
      method: "extension.invoke",
      input: {
        action: "agent-profile.saved-agent-create-v2",
        mutation: agentInstanceMutation("smuggled"),
        owner: "requesteragent",
        grants: { proposeSavedAgent: true },
      },
    } as never);
    expect(created).toMatchObject({ ok: true });
    expect((created as { result: { status: string; message?: string } }).result.status, JSON.stringify(created)).toBe("ok");
    expect(fs.readFileSync(path.join(daemon.workspaceRoot, "tachyon.yml"), "utf8")).toContain("smuggled");
  }, 120_000);
});

function agentInstanceMutation(agentName: string) {
  return {
    schemaVersion: 1,
    kind: "agent-instance",
    agentName,
    editable: {
      displayName: agentName,
      runtime: { adapter: "codex", executable: "codex" },
      role: "",
      cwd: "",
      lifecycle: { autostart: false, restart: "never", attention: true },
      worktree: { enabled: false, branch: "", setup: [] },
        verify: "",
      isolation: "",
    },
  };
}

interface Daemon {
  workspaceRoot: string;
  socketPath: string;
  identity: EngineServiceIdentityV1;
}

/** A socket speaker holding nothing but same-uid filesystem access — no Tachyon client involved. */
interface Speaker {
  invoke(operationId: string, command: unknown): Promise<EngineControlResponseV1>;
}

async function attach(daemon: Daemon, shellId: string): Promise<Speaker> {
  // Every field of the hello is self-asserted; the daemon validates SHAPE, never provenance.
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
    invoke: (operationId, command) =>
      rawRequest(daemon.socketPath, {
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

/** One connection, one JSON line in, one JSON line out — the whole control protocol. */
function rawRequest(socketPath: string, request: EngineControlRequestV1): Promise<EngineControlResponseV1> {
  // The ENTIRE authentication of a control request: a 0600 file owned by the current uid, which every
  // agent Tachyon spawns can read because it runs as that uid.
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
  const root = makeSocketTemp("tachyon-approval-socket-");
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
  // t-70fda0 / t-93ec7f — never let the live fleet's identity reach a daemon fixture.
  const childEnv = isolatedDaemonChildEnv(tmuxChildEnv(), {
    TMUX_TMPDIR: tmuxTmp,
    TACHYON_ENGINE_TMUX_TMPDIR: tmuxTmp,
    XDG_RUNTIME_DIR: xdgRuntime,
  });
  assertNoFleetLeak(childEnv);
  const socketPath = path.join(runtimeRoot, "engine.sock");
  const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
  const worker = path.join(process.cwd(), "test/fixtures/daemonEngineServiceWorker.ts");
  const child = spawn(process.execPath, [viteNode, worker, workspaceRoot, storageRoot, mediaRoot, socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  children.push(child);
  const identity = await readReady(child);
  return { workspaceRoot, socketPath, identity };
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
        if (line.startsWith("TACHYON_ENGINE_READY ")) {
          clearTimeout(timer);
          resolve(JSON.parse(line.slice("TACHYON_ENGINE_READY ".length)) as EngineServiceIdentityV1);
          return;
        }
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
