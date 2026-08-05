/**
 * t-de7df4 — MEASUREMENT, against the production daemon.
 *
 * t-6edd70 measured door 1 (control-socket `approval.resolve`, recorded `resolvedBy: "vscode"`) and
 * closed leaving door 2 EXPLICITLY UNMEASURED: `Workspace.companionResolveApproval` records
 * `resolvedBy: "companion"` and arrives over Companion HTTP with a paired-device session token. Door 2
 * *looked* like the authenticated channel the product was missing — a human gesture on a device
 * outside the box. This file reproduces the whole chain instead of reading it, and it deliberately
 * uses NO Tachyon client: a raw JSON-over-newline speaker on the control socket (nonce read by hand,
 * the only privilege being same-uid) plus a loopback HTTP client, exactly what any spawned agent is.
 *
 * The chain, end to end, with no human and no secret from outside the uid:
 *
 *  1. control socket `extension.query { action: "companion.pair-code" }` — a QUERY action, so the
 *     SAME nonce that resolves an approval also MINTS a pairing code and hands back the loopback
 *     baseUrl to present it to (`extensionOperationService.ts:140-168`, issuing via
 *     `Workspace.issueCompanionPairCode` → `CompanionPairingService.issuePairCode`).
 *  2. loopback HTTP `POST /companion/v1/pair { pairCode, protocolVersion, client }` → device session
 *     token. `CompanionPairingService.pair` authenticates the CODE and nothing else — the code the
 *     caller minted for itself one request earlier.
 *  3. loopback HTTP `POST /companion/v1/approvals/resolve` (Bearer session token) → resolves an
 *     approval the caller never requested. The request record and the `.tachyon/approvals.jsonl`
 *     witness both credit `"companion"`.
 *
 * These are CHARACTERIZATION tests: they pin what the product does today, including the defect. The
 * assertions marked DEFECT are door 2 standing open — `"companion"` was exactly as unproven as
 * `"vscode"`, and any fix that closes only door 1 leaves this one open. When door 2 is closed (pairing
 * gated on a real out-of-uid secret or a human gesture), the DEFECT assertions must be inverted, and
 * their failure at that moment is the point.
 *
 * t-86e59a touched the RECORD, not the door. `resolvedBy` names the CHANNEL now, because the host
 * cannot observe who acted on any of the three doors — so the audit trail stopped crediting a device
 * and a human that were never there. The chain above still runs, start to finish, with no human and no
 * secret from outside the uid. Closing it is t-5313dc, and it is open.
 *
 * ISOLATION / what this test CREATES: like the model test, the daemon runs on a throwaway temp
 * workspace under `isolatedDaemonChildEnv` + `assertNoFleetLeak`, and is killed in `afterEach`. The
 * paired "device" exists ONLY in that ephemeral daemon's in-memory `CompanionPairingService` (the
 * session map is never persisted) and dies with the process. Nothing is written into the live fleet's
 * workspace, so there is nothing to unpair by hand.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
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
  APPROVAL_CHANNEL_COMPANION_HTTP,
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

interface PairCodeValue {
  ok: boolean;
  code: string;
  baseUrl: string;
  protocolVersion: number;
}

describe("t-de7df4 — a same-uid speaker pairs itself as a Companion device and resolves approval", () => {
  it("DEFECT: self-mints a pair code, pairs over loopback, resolves an approval it never requested — credited 'companion'", async () => {
    const daemon = await startDaemon();

    // A pending human approval, written the way the Bridge writes it: `requester` is the Bridge-
    // resolved caller and cannot be self-declared. That identity survives on the record and is never
    // consulted at resolve time — same as door 1 in the t-6edd70 model test.
    const request = buildApprovalRequest({
      requester: "requesteragent",
      session: "tachyon-requesteragent",
      reason: "needs a human to authorize removing a safety guard",
      proposedAction: "remove the guard",
      risk: "high",
      exactPrompt: "may I remove it?",
      id: "a-bbb222",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    writeApprovalRequest(daemon.workspaceRoot, request);
    expect(readApprovalRequest(daemon.workspaceRoot, "a-bbb222").status).toBe("pending");

    const speaker = await attach(daemon, "shell-not-an-extension-host");

    // (1) Ask the daemon for a pairing code over the raw control socket. `companion.pair-code` is a
    // QUERY action reachable by the same nonce as everything else; the response also hands back the
    // loopback baseUrl to send it to. No gesture, no device — the caller mints its own credential.
    const issued = await speaker.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "companion.pair-code" },
    });
    expect(issued, JSON.stringify(issued)).toMatchObject({ ok: true, op: "query" });
    const pair = (issued as unknown as { result: { value: PairCodeValue } }).result.value;
    expect(pair.ok, JSON.stringify(pair)).toBe(true);
    expect(typeof pair.code).toBe("string");
    expect(pair.code.length).toBeGreaterThan(0);
    // DEFECT: the pairing SECRET and the address to redeem it were both handed to a caller holding
    // nothing but same-uid. Door 2's "paired device" is a code the caller minted for itself.
    expect(pair.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // (2) Present that code back over loopback HTTP and mint a device session token. `pair()`
    // checks only that the code matches the pending one — the one just minted above.
    const paired = await httpJson(pair.baseUrl, "POST", "/companion/v1/pair", {
      body: {
        pairCode: pair.code,
        protocolVersion: pair.protocolVersion,
        client: { kind: "browser", name: "not-a-real-device", version: "0" },
      },
    });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    const sessionToken = (paired.body as { ok: boolean; sessionToken?: string }).sessionToken;
    expect(typeof sessionToken, JSON.stringify(paired.body)).toBe("string");

    // (3) Resolve the pending approval through door 2 with the self-minted device token.
    const resolvedResp = await httpJson(pair.baseUrl, "POST", "/companion/v1/approvals/resolve", {
      bearer: sessionToken,
      body: { id: "a-bbb222", decision: "approved" },
    });
    expect(resolvedResp.status, JSON.stringify(resolvedResp.body)).toBe(200);
    expect(resolvedResp.body).toMatchObject({ ok: true, status: "approved" });

    const record = readApprovalRequest(daemon.workspaceRoot, "a-bbb222");
    expect(record.status).toBe("resolved");
    expect(record.resolution?.decision).toBe("approved");
    // DEFECT: door 2 IS STILL OPEN. It was the candidate for the missing authenticated channel — "a
    // human on a paired device outside the box" — and it authenticated only the pair code, which the
    // caller minted for itself over the same-uid socket. Everything above still happens.
    //
    // What t-86e59a changed is only what the record CLAIMS about it. The durable record used to credit
    // `"companion"` for a resolution no device and no human performed; it now names the CHANNEL, which
    // is all this call site knows. The capability is untouched and stays open as t-5313dc — the mark
    // above measures that, and inverting it is t-5313dc's job, not this one's.
    expect(record.resolution?.resolvedBy).toBe(APPROVAL_CHANNEL_COMPANION_HTTP);
    expect(record.resolution?.resolvedBy).not.toBe("companion");

    // The witness ledger repeats the value, durable in two places — the exact shape door 1 leaves
    // behind, and the reason both had to stop asserting an actor in the same change.
    const witness = fs.readFileSync(path.join(daemon.workspaceRoot, ".tachyon", "approvals.jsonl"), "utf8");
    expect(witness).toContain('"kind":"resolved"');
    expect(witness).toContain(`"by":"${APPROVAL_CHANNEL_COMPANION_HTTP}"`);
    expect(witness).not.toContain('"by":"companion"');
  }, 120_000);

  it("the pair code IS the whole gate — a wrong code is refused, so minting it is the entire exploit", async () => {
    // Negative control: without the self-minted code, /pair refuses. This is what makes the first test
    // a real finding rather than an open door — the daemon DOES authenticate the code; the defect is
    // only that the code is obtainable from the same socket the approval lives on.
    const daemon = await startDaemon();
    const speaker = await attach(daemon, "shell-not-an-extension-host");

    // Mint a code so a pending code exists (so refusal is "wrong code", not "no code at all").
    const issued = await speaker.query({
      schemaVersion: 1,
      method: "extension.query",
      input: { action: "companion.pair-code" },
    });
    const pair = (issued as unknown as { result: { value: PairCodeValue } }).result.value;

    const refused = await httpJson(pair.baseUrl, "POST", "/companion/v1/pair", {
      body: {
        pairCode: "WRONGCOD", // 8 chars, same shape, not the pending code
        protocolVersion: pair.protocolVersion,
        client: { kind: "browser", name: "not-a-real-device", version: "0" },
      },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "invalid_code" });

    // And a resolve attempt with no session token is unauthorized — door 2 is shut to a caller that
    // did NOT pair. The whole reachability turns on step 1 minting the code for itself.
    const unauth = await httpJson(pair.baseUrl, "POST", "/companion/v1/approvals/resolve", {
      body: { id: "a-whatever", decision: "approved" },
    });
    expect(unauth.status, JSON.stringify(unauth.body)).toBe(401);
    expect(unauth.body).toMatchObject({ ok: false, code: "unpaired" });
  }, 120_000);
});

interface Daemon {
  workspaceRoot: string;
  socketPath: string;
  identity: EngineServiceIdentityV1;
}

/** A socket speaker holding nothing but same-uid filesystem access — no Tachyon client involved. */
interface Speaker {
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

/** Loopback HTTP JSON — the Companion device's whole surface. No Bridge agent token is ever sent. */
function httpJson(
  baseUrl: string,
  method: string,
  sub: string,
  opts?: { body?: unknown; bearer?: string },
): Promise<{ status: number; body: unknown }> {
  const url = new URL(sub, baseUrl);
  const payload = opts?.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          ...(payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...(opts?.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (out += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : undefined }));
      },
    );
    req.once("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("http request timed out")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startDaemon(): Promise<Daemon> {
  const root = makeSocketTemp("tachyon-companion-pair-");
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
