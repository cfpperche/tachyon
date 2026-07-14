import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ensureSecureRuntimeDir } from "../bridge/persistentProxyProtocol.js";
import {
  isEngineShellHelloV1,
  isEngineOperationId,
  isWorkspaceCommandResultV1,
  isWorkspaceCommandV1,
  negotiateEngineShellProtocol,
  type EngineControlRequestV1,
  type EngineControlResponseV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
  type EngineShellSessionV1,
  isWorkspaceEventBatchV1,
  type WorkspaceEventBatchV1,
  type WorkspaceCommandResultV1,
  type WorkspaceCommandV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "./protocol.js";

const MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
const DEFAULT_SHELL_LEASE_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const CONTROL_COMMAND_TIMEOUT_MS = 60_000;
const MAX_OPERATION_RECORDS = 2_048;

export interface EngineCommandContextV1 {
  shellId: string;
  operationId: string;
}

export interface EngineControlServerOptions {
  socketPath: string;
  identity: EngineServiceIdentityV1;
  getSnapshot: () => unknown | Promise<unknown>;
  readEvents?: (afterSeq: number, limit: number) => unknown | Promise<unknown>;
  invoke?: (command: WorkspaceCommandV1, context: EngineCommandContextV1) => WorkspaceCommandResultV1 | Promise<WorkspaceCommandResultV1>;
  leaseMs?: number;
  now?: () => number;
}

export interface RunningEngineControlServer {
  socketPath: string;
  shellCount(): number;
  close(): Promise<void>;
}

interface LiveShellSession {
  helloFingerprint: string;
  token: string;
  protocol: number;
  expiresAt: number;
}

interface OperationRecord {
  fingerprint: string;
  promise: Promise<WorkspaceCommandResultV1>;
  settled: boolean;
}

export async function startEngineControlServer(options: EngineControlServerOptions): Promise<RunningEngineControlServer> {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_SHELL_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("engine shell leaseMs must be a positive integer");
  ensureSecureRuntimeDir(path.dirname(options.socketPath));

  const sessions = new Map<string, LiveShellSession>();
  const operations = new Map<string, OperationRecord>();
  const connections = new Set<net.Socket>();
  let closing = false;
  const purgeExpired = () => {
    const at = now();
    for (const [shellId, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(shellId);
    }
  };

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_REQUEST_BYTES) {
        handled = true;
        respond(socket, fail("REQUEST_TOO_LARGE", "engine control request exceeds the size limit"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const parsed = parseRequest(input.slice(0, newline));
      if (!("ok" in parsed) && parsed.op === "invoke") socket.setTimeout(CONTROL_COMMAND_TIMEOUT_MS);
      void handle(parsed).then(
        (response) => respond(socket, response),
        (error) => respond(socket, fail("INTERNAL", error instanceof Error ? error.message : String(error))),
      );
    });
  });

  const handle = async (parsed: EngineControlRequestV1 | EngineControlResponseV1): Promise<EngineControlResponseV1> => {
    if ("ok" in parsed) return parsed;
    purgeExpired();
    if (parsed.schemaVersion !== 1) return fail("PROTOCOL_MISMATCH", "unsupported engine control schema");
    if (parsed.workspaceHash !== options.identity.workspaceHash) return fail("WRONG_WORKSPACE", "workspace identity mismatch");
    if (parsed.op === "health") {
      return { ok: true, op: "health", engine: options.identity, shellCount: sessions.size };
    }
    if (parsed.op === "attach") {
      if (!isEngineShellHelloV1(parsed.hello)) return fail("BAD_HELLO", "invalid engine shell hello");
      if (parsed.hello.workspaceHash !== options.identity.workspaceHash) return fail("WRONG_WORKSPACE", "workspace identity mismatch");
      let canonicalRoot: string;
      try {
        canonicalRoot = fs.realpathSync(parsed.hello.workspaceRoot);
      } catch {
        return fail("WRONG_WORKSPACE", "workspace root is unavailable");
      }
      if (canonicalRoot !== options.identity.workspaceRoot) return fail("WRONG_WORKSPACE", "canonical workspace root mismatch");
      const protocol = negotiateEngineShellProtocol(options.identity.protocol, parsed.hello.protocol);
      if (protocol === undefined) return fail("PROTOCOL_MISMATCH", "engine and shell protocol ranges do not overlap");
      const fingerprint = helloFingerprint(parsed.hello);
      const existing = sessions.get(parsed.hello.shell.id);
      if (existing && existing.helloFingerprint !== fingerprint) {
        return fail("SHELL_ID_CONFLICT", "shell id is already attached with different identity or capabilities");
      }
      const snapshot = validateSnapshot(await options.getSnapshot(), options.identity);
      const session: LiveShellSession = existing ?? {
        helloFingerprint: fingerprint,
        token: randomBytes(32).toString("base64url"),
        protocol,
        expiresAt: 0,
      };
      session.expiresAt = now() + leaseMs;
      sessions.set(parsed.hello.shell.id, session);
      return { ok: true, op: "attach", session: publicSession(parsed.hello.shell.id, session, snapshot.seq, options.identity) };
    }

    const session = authenticateSession(sessions, parsed.shellId, parsed.sessionToken);
    if (!session) return fail("SHELL_SESSION_INVALID", "shell session is missing, expired or invalid");
    if (parsed.op === "invoke") {
      session.expiresAt = now() + leaseMs;
      return {
        ok: true,
        op: "invoke",
        operationId: parsed.operationId,
        result: await invokeOnce(parsed.operationId, parsed.command, parsed.shellId),
      };
    }
    if (parsed.op === "touch") {
      const validated = validateSnapshot(await options.getSnapshot(), options.identity);
      session.expiresAt = now() + leaseMs;
      return { ok: true, op: "touch", session: publicSession(parsed.shellId, session, validated.seq, options.identity) };
    }
    if (parsed.op === "snapshot") {
      const snapshot = validateSnapshot(await options.getSnapshot(), options.identity);
      session.expiresAt = now() + leaseMs;
      return { ok: true, op: "snapshot", snapshot };
    }
    if (parsed.op === "events") {
      if (!options.readEvents) return fail("UNSUPPORTED_OPERATION", "engine event reads are unavailable");
      const batch = validateEventBatch(
        await options.readEvents(parsed.afterSeq, parsed.limit),
        options.identity,
        parsed.afterSeq,
        parsed.limit,
      );
      session.expiresAt = now() + leaseMs;
      return { ok: true, op: "events", batch };
    }
    sessions.delete(parsed.shellId);
    return { ok: true, op: "detach", detached: true };
  };

  const invokeOnce = async (
    operationId: string,
    command: WorkspaceCommandV1,
    shellId: string,
  ): Promise<WorkspaceCommandResultV1> => {
    const fingerprint = commandFingerprint(command);
    const existing = operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return commandFailure(command, "OPERATION_ID_CONFLICT", "operation id was already used for a different command");
      }
      return existing.promise;
    }
    if (operations.size >= MAX_OPERATION_RECORDS) {
      for (const [id, record] of operations) {
        if (!record.settled) continue;
        operations.delete(id);
        if (operations.size < MAX_OPERATION_RECORDS) break;
      }
    }
    if (operations.size >= MAX_OPERATION_RECORDS) {
      return commandFailure(command, "OPERATION_CAPACITY", "engine operation registry is temporarily full");
    }
    const record: OperationRecord = {
      fingerprint,
      settled: false,
      promise: Promise.resolve().then(async () => {
        if (!options.invoke) return commandFailure(command, "UNSUPPORTED_OPERATION", "engine command invocation is unavailable");
        try {
          const result = await options.invoke(command, { shellId, operationId });
          if (!isWorkspaceCommandResultV1(result) || result.method !== command.method) {
            return commandFailure(command, "INVALID_COMMAND_RESULT", "engine command returned an invalid result");
          }
          return result;
        } catch (error) {
          return commandFailure(
            command,
            "COMMAND_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    };
    operations.set(operationId, record);
    void record.promise.finally(() => { record.settled = true; });
    return record.promise;
  };

  await listen(server, options.socketPath);
  fs.chmodSync(options.socketPath, 0o600);
  const socketIdentity = fs.lstatSync(options.socketPath);
  const timer = setInterval(purgeExpired, Math.min(leaseMs, 5_000));
  timer.unref?.();

  return {
    socketPath: options.socketPath,
    shellCount: () => {
      purgeExpired();
      return sessions.size;
    },
    close: async () => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      sessions.clear();
      operations.clear();
      for (const socket of connections) socket.destroy();
      await closeServer(server);
      try {
        const current = fs.lstatSync(options.socketPath);
        if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) fs.unlinkSync(options.socketPath);
      } catch {
        // Missing or replaced socket: never unlink a path whose identity is no longer ours.
      }
    },
  };
}

function parseRequest(raw: string): EngineControlRequestV1 | EngineControlResponseV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("BAD_REQUEST", "engine control request is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("BAD_REQUEST", "engine control request is invalid");
  const request = value as Partial<EngineControlRequestV1>;
  if (request.schemaVersion !== 1 || typeof request.op !== "string" || typeof request.workspaceHash !== "string") {
    return fail("BAD_REQUEST", "engine control request is invalid");
  }
  if (request.op === "health") return request as EngineControlRequestV1;
  if (request.op === "attach" && "hello" in request) return request as EngineControlRequestV1;
  if ((request.op === "touch" || request.op === "snapshot" || request.op === "detach" || request.op === "events" || request.op === "invoke")
    && "shellId" in request && typeof request.shellId === "string"
    && "sessionToken" in request && typeof request.sessionToken === "string") {
    if (request.op === "invoke") {
      if ("operationId" in request && isEngineOperationId(request.operationId)
        && "command" in request && isWorkspaceCommandV1(request.command)) return request as EngineControlRequestV1;
      return fail("BAD_REQUEST", "unknown or incomplete engine control request");
    }
    if (request.op !== "events") return request as EngineControlRequestV1;
    if ("afterSeq" in request && Number.isSafeInteger(request.afterSeq)
      && (request.afterSeq as number) >= 0
      && "limit" in request && Number.isSafeInteger(request.limit)
      && (request.limit as number) > 0 && (request.limit as number) <= 200) return request as EngineControlRequestV1;
  }
  return fail("BAD_REQUEST", "unknown or incomplete engine control request");
}

function validateEventBatch(
  batch: unknown,
  identity: EngineServiceIdentityV1,
  afterSeq: number,
  limit: number,
): WorkspaceEventBatchV1 {
  if (!isWorkspaceEventBatchV1(batch)
    || batch.engineInstanceId !== identity.instanceId
    || batch.afterSeq !== afterSeq
    || batch.events.length > limit) {
    throw new Error("engine event batch violates its identity/sequence contract");
  }
  return batch;
}

function validateSnapshot(snapshot: unknown, identity: EngineServiceIdentityV1): WorkspaceSnapshotEnvelopeV1 {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("engine snapshot violates its identity/sequence contract");
  }
  const candidate = snapshot as Partial<WorkspaceSnapshotEnvelopeV1>;
  if (candidate.schemaVersion !== 1
    || candidate.engineInstanceId !== identity.instanceId
    || !Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 0
    || !candidate.projections || typeof candidate.projections !== "object" || Array.isArray(candidate.projections)) {
    throw new Error("engine snapshot violates its identity/sequence contract");
  }
  return candidate as WorkspaceSnapshotEnvelopeV1;
}

function publicSession(
  shellId: string,
  session: LiveShellSession,
  snapshotSeq: number,
  engine: EngineServiceIdentityV1,
): EngineShellSessionV1 {
  return {
    schemaVersion: 1,
    shellId,
    sessionToken: session.token,
    protocol: session.protocol,
    engine,
    snapshotSeq,
    leaseExpiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function authenticateSession(
  sessions: Map<string, LiveShellSession>,
  shellId: string,
  token: string,
): LiveShellSession | undefined {
  const session = sessions.get(shellId);
  if (!session) return undefined;
  const expected = Buffer.from(session.token);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return session;
}

function helloFingerprint(hello: EngineShellHelloV1): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceRoot: hello.workspaceRoot,
    workspaceHash: hello.workspaceHash,
    shell: hello.shell,
    protocol: hello.protocol,
    capabilities: [...hello.capabilities].sort(),
    settingsDigest: hello.settingsDigest,
  })).digest("hex");
}

function fail(code: string, message: string): EngineControlResponseV1 {
  return { ok: false, code, message };
}

function commandFailure(
  command: WorkspaceCommandV1,
  code: string,
  message: string,
): WorkspaceCommandResultV1 {
  const bounded = message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "engine command failed";
  return { schemaVersion: 1, method: command.method, status: "error", code, message: bounded };
}

function commandFingerprint(command: WorkspaceCommandV1): string {
  return createHash("sha256")
    .update(JSON.stringify([command.schemaVersion, command.method, command.input.agent]))
    .digest("hex");
}

function respond(socket: net.Socket, response: EngineControlResponseV1): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}
