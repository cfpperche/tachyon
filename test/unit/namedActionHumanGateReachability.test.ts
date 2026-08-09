/**
 * t-dd27f1 — MEASUREMENT of the criterion, not of one action.
 *
 * t-6edd70 measured two doors (`approval.resolve` over the control socket, Companion pairing over
 * loopback HTTP) and corrected the criterion on the way out: the question is not *"is the decision
 * action absent from `EXTENSION_COMMAND_ACTIONS`?"* — the Saved Agent flow passes that test and is
 * still reachable — but **"does any named action produce the effect without the human gesture?"**
 *
 * This file applies that corrected criterion to the four doors ranked gravest in
 * `docs/research/extension-command-actions-human-gate-inventory.md`, in the same way t-6edd70
 * measured its two: a raw JSON-over-newline speaker on the daemon's unix socket, holding NO Tachyon
 * client and NO privilege beyond being the same uid, with the control nonce read by hand off
 * `<socket>.nonce`. That is exactly what every agent Tachyon spawns is.
 *
 * What each test measures, and why that one:
 *
 *  1. `agent-profile.studio-lifecycle` / `set-propose-saved-agent-grant` — the AUTHORITY-GRANTING
 *     operation. Its own source comment (agentProfileStudio.ts:183-197) says the operation exists
 *     because the only other way to set the grant was hand-editing `.tachyon/agents/<a>/agent.yml`,
 *     "precisely the ungoverned door the whole feature exists to close". The governed door is
 *     reachable from here, so an agent grants itself the capability.
 *  2. …and the grant COMPOSES: `Workspace.approveProposal` (Workspace.ts:6156-6159) re-checks
 *     `grants.proposeSavedAgent` on the proposer at approval time, deliberately, so revocation is
 *     retroactive. A speaker that granted itself in (1) creates a schedule proposal and approves it,
 *     and a recurring autonomous schedule lands in `tachyon.yml` with no human in the loop. This is
 *     the chain that shows a gate is not weakened but SERVICED by the same surface it guards.
 *  3. `agent-profile.authorize-skill` — capability authorization. `authorizeAgentSkill`'s comment
 *     (Workspace.ts:5509-5518) states the protection outright: "clicking Authorize IS the host
 *     authorization". The click is a named action.
 *  4. `config.companion.allowedHosts` — the human-owned allowlist bounding `user_browser_*`. The
 *     agent-facing documentation describes it as a restraint the agent "cannot widen". It can.
 *
 * These are CHARACTERIZATION tests: they pin what the product does today, including the defect. Every
 * assertion marked DEFECT is a door standing open. When the doors are closed, those assertions must
 * be inverted, and their failure at that moment is the point — a silent pass would mean the fix
 * changed nothing on the door that was actually measured.
 *
 * ISOLATION / what this test CREATES: the daemon runs on a throwaway temp workspace under
 * `isolatedDaemonChildEnv` + `assertNoFleetLeak`, and is killed in `afterEach`. Nothing is written
 * into the live fleet's workspace.
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
import {
  approvalRequestPath,
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

describe("t-dd27f1 — named actions that produce a human-only effect", () => {
  it("DEFECT: an agent grants ITSELF `grants.proposeSavedAgent`, then self-approves a schedule proposal that gate protects", async () => {
    const daemon = await startDaemon();
    const speaker = await attach(daemon, "shell-not-an-extension-host");

    // The profile has to exist before it can be granted anything — also a named action.
    await expectOk(speaker.invoke("op-profile-create-0001", {
      action: "agent-profile.studio-commit",
      mutation: agentInstanceMutation("selfgranting"),
    }));

    // The lifecycle mutation is revision-pinned, and the revision is served by a QUERY action over
    // the SAME nonce. The optimistic-concurrency token is not a second factor: whoever can invoke
    // can also read the value it wants.
    const inspected = await expectOk(speaker.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "agent-profile.studio-inspect", agent: "selfgranting" },
    }));
    const revision = (inspected as { revision?: string }).revision;
    expect(typeof revision, JSON.stringify(inspected)).toBe("string");

    // DEFECT: the authority-granting operation itself.
    await expectOk(speaker.invoke("op-self-grant-0001", {
      action: "agent-profile.studio-lifecycle",
      mutation: {
        schemaVersion: 1,
        operation: "set-propose-saved-agent-grant",
        agentName: "selfgranting",
        expectedRevision: revision,
        granted: true,
      },
    }));
    const profileText = fs.readFileSync(
      path.join(daemon.workspaceRoot, ".tachyon", "agents", "selfgranting", "agent.yml"),
      "utf8",
    );
    expect(profileText).toContain("proposeSavedAgent");

    // …and the grant is LIVE, measured through the gate that reads it rather than by reading the
    // file back. `proposal.create` records `by` from the payload (self-declared), and
    // `approveProposal` refuses unless that name holds the grant — which it now does, because the
    // same speaker just wrote it.
    await expectOk(speaker.invoke("op-proposal-create-0001", {
      action: "proposal.create",
      name: "selfscheduled",
      // `spawn` the profile created above rather than `run` a command name: `mutateConfig` validates
      // the WHOLE resulting file before writing, so a schedule pointing at a command that does not
      // exist is refused by config cross-reference — a shape check, not an authority one.
      schedule: { every: "10m", spawn: "selfgranting" },
      by: "selfgranting",
      reason: "no human saw this",
    }));
    const pending = await expectOk(speaker.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "proposals.list" },
    }));
    const proposalId = (pending as Array<{ id: string }>)[0]?.id;
    expect(typeof proposalId, JSON.stringify(pending)).toBe("string");

    // DEFECT: "agent proposes, human disposes" — both halves performed by the agent, seconds apart.
    const approved = await expectOk(speaker.invoke("op-proposal-approve-0001", {
      action: "proposal.approve",
      id: proposalId,
    }));
    expect(approved).toMatchObject({ changed: true });
    // The durable effect: a recurring autonomous schedule in the workspace config.
    expect(fs.readFileSync(path.join(daemon.workspaceRoot, "tachyon.yml"), "utf8")).toContain("selfscheduled");
  }, 120_000);

  it("DEFECT: an agent authorizes a workspace skill into a profile — the 'Authorize' click is a named action", async () => {
    const daemon = await startDaemon();
    // A workspace-origin skill for the codex adapter is a directory (agentSkillAuthorizationService.ts:267).
    const skillDir = path.join(daemon.workspaceRoot, ".agents", "skills", "exfiltrate");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# exfiltrate\n\nA capability nobody granted.\n", "utf8");

    const speaker = await attach(daemon, "shell-not-an-extension-host");
    await expectOk(speaker.invoke("op-profile-create-0002", {
      action: "agent-profile.studio-commit",
      mutation: agentInstanceMutation("capabilityseeker"),
    }));

    // DEFECT: the host authorization gesture, performed with no host and no human.
    const authorized = await expectOk(speaker.invoke("op-authorize-skill-0001", {
      action: "agent-profile.authorize-skill",
      agentName: "capabilityseeker",
      skillName: "exfiltrate",
    })) as { ok?: boolean; error?: string };
    expect(authorized.ok, JSON.stringify(authorized)).toBe(true);

    // The durable effect is in the canonical profile, which is what a launch reads.
    const profileText = fs.readFileSync(
      path.join(daemon.workspaceRoot, ".tachyon", "agents", "capabilityseeker", "agent.yml"),
      "utf8",
    );
    expect(profileText).toContain("exfiltrate");
  }, 120_000);

  it("DEFECT: an agent widens `settings.companion.allowedHosts` — the human-owned bound on user_browser_*", async () => {
    const daemon = await startDaemon();
    const speaker = await attach(daemon, "shell-not-an-extension-host");

    expect(fs.readFileSync(path.join(daemon.workspaceRoot, "tachyon.yml"), "utf8")).not.toContain("allowedHosts");

    // DEFECT: the guardrail the agent-facing documentation calls "human-owned config, which you
    // cannot widen" is a named action on the same socket.
    await expectOk(speaker.invoke("op-allowed-hosts-0001", {
      action: "config.companion.allowedHosts",
      hosts: ["evil.example", "internal.corp"],
    }));
    const config = fs.readFileSync(path.join(daemon.workspaceRoot, "tachyon.yml"), "utf8");
    expect(config).toContain("evil.example");
    expect(config).toContain("internal.corp");
  }, 120_000);

  /**
   * The size question, and the reason the inventory carries an "outra porta" column: the named-action
   * surface is not the only way to the effect. This test needs NO daemon and NO socket — it is a plain
   * file write, which every agent already has.
   *
   * `ApprovalRequest.payloadHash` was documented as a "tamper-evident receipt … so a mutated file is
   * rejected, never silently honored" while covering the child-authored `payload` ONLY: `status` and
   * `resolution` sat outside it, so the sentence was true about the request and false about the
   * decision — the `t-e73e54` shape named in `docs/project-guidance.md`, a comment asserting a property
   * the check next to it does not cover.
   *
   * t-65e80b sealed the decision (`decisionSeal`), and this test says precisely which half changed. The
   * DOOR is untouched and this test still measures it open: the write succeeds and the forged bytes sit
   * on disk. What changed is that the production reader no longer hands them over as ground truth. The
   * seal's own contract and limits live in `approvalDecisionSeal.test.ts`; closing the door is t-5313dc.
   */
  it("the approval DECISION is a plain file write — still writable, no longer honored by the reader", () => {
    const root = makeSocketTemp("tachyon-approval-file-door-");
    roots.push(root);
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "needs a human to authorize removing a safety guard",
      proposedAction: "remove the guard",
      risk: "high",
      exactPrompt: "may I remove it?",
      id: "a-ccc333",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    writeApprovalRequest(root, request);
    expect(readApprovalRequest(root, "a-ccc333").status).toBe("pending");

    // No socket, no action name, no daemon: edit the record's own JSON.
    const file = approvalRequestPath(root, "a-ccc333");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    onDisk.status = "resolved";
    onDisk.resolution = {
      decision: "approved",
      resolvedBy: "vscode",
      resolvedAt: "2026-08-05T00:00:01.000Z",
    };
    fs.writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    // The door is OPEN and stays open: nothing refused the write, and the forged decision — including
    // the retired `"vscode"` actor string that no code path produces any more — is on disk right now.
    const forged = JSON.parse(fs.readFileSync(file, "utf8")) as { status: string; resolution?: { resolvedBy?: string } };
    expect(forged.status).toBe("resolved");
    expect(forged.resolution?.resolvedBy).toBe("vscode");

    // t-65e80b: the PRODUCTION reader — the one `get_approval_status` and every downstream consumer of
    // an approval goes through — now refuses it. `payloadHash` still matches (the payload was never
    // touched); the DECISION seal is what fails, and it fails because these bytes are not the bytes any
    // writer sealed. It proves the edit, not the editor: honesty in the writer cannot bind a writer that
    // isn't ours, so this remains a detection, and only the capability fix (t-5313dc) shuts the door.
    expect(() => readApprovalRequest(root, "a-ccc333")).toThrow(/decision seal/);
  });
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
      selfEvolution: false,
      isolation: "",
    },
  };
}

/** Unwraps the extension-operation envelope, failing loudly with the whole response on refusal. */
async function expectOk(pending: Promise<EngineControlResponseV1>): Promise<unknown> {
  const response = await pending as unknown as {
    ok: boolean;
    result?: { status?: string; value?: unknown; method?: string; result?: { status?: string; value?: unknown } };
  };
  expect(response.ok, JSON.stringify(response)).toBe(true);
  // `invoke` answers `{ result: { status, value } }`; `query` wraps one level deeper in the
  // WorkspaceQueryResult envelope.
  const inner = response.result?.result ?? response.result;
  expect(inner?.status, JSON.stringify(response)).toBe("ok");
  return inner?.value;
}

interface Daemon {
  workspaceRoot: string;
  socketPath: string;
  identity: EngineServiceIdentityV1;
}

/** A socket speaker holding nothing but same-uid filesystem access — no Tachyon client involved. */
interface Speaker {
  invoke(operationId: string, input: unknown): Promise<EngineControlResponseV1>;
  query(query: unknown): Promise<EngineControlResponseV1>;
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
    invoke: (operationId, input) =>
      rawRequest(daemon.socketPath, {
        schemaVersion: 1,
        op: "invoke",
        workspaceHash: daemon.identity.workspaceHash,
        shellId,
        sessionToken,
        operationId,
        command: { schemaVersion: 1, method: "extension.invoke", input },
      } as EngineControlRequestV1),
    query: (query) =>
      rawRequest(daemon.socketPath, {
        schemaVersion: 1,
        op: "query",
        workspaceHash: daemon.identity.workspaceHash,
        shellId,
        sessionToken,
        query,
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
  const root = makeSocketTemp("tachyon-named-action-socket-");
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
