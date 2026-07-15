import fs from "node:fs";
import net from "node:net";
import {
  HANDOFF_VIEW_RESPONSE_MAX_BYTES,
  MISSION_CONTROL_RESPONSE_MAX_BYTES,
  PIN_STUDIO_RESPONSE_MAX_BYTES,
  TASK_DETAIL_RESPONSE_MAX_BYTES,
  TASK_STUDIO_RESPONSE_MAX_BYTES,
  isEngineControlResponseV1,
  isEngineOperationId,
  isWorkspaceCommandV1,
  isWorkspaceQueryV1,
  type EngineControlRequestV1,
  type EngineControlResponseV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
  type EngineShellSessionV1,
  type WorkspaceEventBatchV1,
  type WorkspaceCommandResultV1,
  type WorkspaceCommandV1,
  type WorkspaceQueryResultV1,
  type WorkspaceQueryV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "./protocol.js";

const DEFAULT_CONTROL_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

export type EngineControlClientErrorCode = "UNAVAILABLE" | "TIMEOUT" | "INVALID_RESPONSE" | "REMOTE" | "NOT_ATTACHED";

export class EngineControlClientError extends Error {
  constructor(
    readonly code: EngineControlClientErrorCode,
    message: string,
    readonly remoteCode?: string,
    readonly systemCode?: string,
  ) {
    super(message);
    this.name = "EngineControlClientError";
  }
}

export interface EngineControlClientOptions {
  socketPath: string;
  hello: EngineShellHelloV1;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Short-lived transport client used by the VS Code shell.  It owns only an ephemeral shell lease;
 * dropping this object or its process never owns, stops or reconstructs the engine.
 */
export class EngineControlClient {
  private currentSession: EngineShellSessionV1 | undefined;
  private lastSnapshotSeq: number | undefined;
  private lastEventSeq: number | undefined;
  private readonly timeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: EngineControlClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("engine control timeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
      throw new Error("engine command timeoutMs must be a positive integer");
    }
  }

  get engine(): EngineServiceIdentityV1 | undefined {
    return this.currentSession?.engine;
  }

  get attached(): boolean {
    return this.currentSession !== undefined;
  }

  async health(): Promise<{ engine: EngineServiceIdentityV1; shellCount: number }> {
    const response = await this.request({ schemaVersion: 1, op: "health", workspaceHash: this.options.hello.workspaceHash });
    const success = this.unwrap(response);
    if (success.op !== "health") throw invalidResponse("health request returned the wrong operation");
    this.assertEngineWorkspace(success.engine);
    return { engine: success.engine, shellCount: success.shellCount };
  }

  async attach(): Promise<EngineShellSessionV1> {
    const response = await this.request({
      schemaVersion: 1,
      op: "attach",
      workspaceHash: this.options.hello.workspaceHash,
      hello: this.options.hello,
    });
    const success = this.unwrap(response);
    if (success.op !== "attach") throw invalidResponse("attach request returned the wrong operation");
    this.assertSession(success.session);
    this.currentSession = success.session;
    this.lastSnapshotSeq = success.session.snapshotSeq;
    this.lastEventSeq = success.session.snapshotSeq;
    return success.session;
  }

  async touch(): Promise<EngineShellSessionV1> {
    const session = this.requireSession();
    const response = await this.request(this.sessionRequest("touch", session));
    const success = this.unwrap(response);
    if (success.op !== "touch") throw invalidResponse("touch request returned the wrong operation");
    this.assertSameSession(success.session, session);
    this.assertMonotonic(success.session.snapshotSeq);
    this.currentSession = success.session;
    return success.session;
  }

  async snapshot(): Promise<WorkspaceSnapshotEnvelopeV1> {
    const session = this.requireSession();
    const response = await this.request(this.sessionRequest("snapshot", session));
    const success = this.unwrap(response);
    if (success.op !== "snapshot") throw invalidResponse("snapshot request returned the wrong operation");
    if (success.snapshot.engineInstanceId !== session.engine.instanceId) {
      throw invalidResponse("snapshot belongs to a different engine incarnation");
    }
    this.assertMonotonic(success.snapshot.seq);
    this.lastEventSeq = success.snapshot.seq;
    return success.snapshot;
  }

  async events(limit = 100): Promise<WorkspaceEventBatchV1> {
    const session = this.requireSession();
    const afterSeq = this.lastEventSeq ?? session.snapshotSeq;
    const response = await this.request({
      schemaVersion: 1,
      op: "events",
      workspaceHash: this.options.hello.workspaceHash,
      shellId: session.shellId,
      sessionToken: session.sessionToken,
      afterSeq,
      limit,
    });
    const success = this.unwrap(response);
    if (success.op !== "events") throw invalidResponse("events request returned the wrong operation");
    const batch = success.batch;
    if (batch.engineInstanceId !== session.engine.instanceId || batch.afterSeq !== afterSeq) {
      throw invalidResponse("event batch belongs to a different engine or cursor");
    }
    if (!batch.resyncRequired) {
      const last = batch.events.at(-1)?.seq ?? afterSeq;
      if (last < afterSeq || last > batch.latestSeq) throw invalidResponse("event batch cursor is invalid");
      this.lastEventSeq = last;
    }
    return batch;
  }

  /** Sends one authenticated side-effect-free read outside the mutation operation registry. */
  async query(query: WorkspaceQueryV1): Promise<WorkspaceQueryResultV1> {
    if (!isWorkspaceQueryV1(query)) {
      throw new EngineControlClientError("INVALID_RESPONSE", "engine query request is invalid");
    }
    const session = this.requireSession();
    const response = await this.request({
      schemaVersion: 1,
      op: "query",
      workspaceHash: this.options.hello.workspaceHash,
      shellId: session.shellId,
      sessionToken: session.sessionToken,
      query,
    }, this.commandTimeoutMs);
    const success = this.unwrap(response);
    if (success.op !== "query" || success.result.method !== query.method) {
      throw invalidResponse("query response does not match its request");
    }
    if (query.method === "probe.view" && success.result.status === "ok"
      && success.result.method === "probe.view" && success.result.view.caller !== query.input.caller) {
      throw invalidResponse("query response belongs to a different Probe caller");
    }
    return success.result;
  }

  /** Sends one idempotency-keyed mutation. Transport failures are deliberately not retried here. */
  async invoke(operationId: string, command: WorkspaceCommandV1): Promise<WorkspaceCommandResultV1> {
    if (!isEngineOperationId(operationId) || !isWorkspaceCommandV1(command)) {
      throw new EngineControlClientError("INVALID_RESPONSE", "engine command request is invalid");
    }
    const session = this.requireSession();
    const response = await this.request({
      schemaVersion: 1,
      op: "invoke",
      workspaceHash: this.options.hello.workspaceHash,
      shellId: session.shellId,
      sessionToken: session.sessionToken,
      operationId,
      command,
    }, this.commandTimeoutMs);
    const success = this.unwrap(response);
    if (success.op !== "invoke"
      || success.operationId !== operationId
      || success.result.method !== command.method) {
      throw invalidResponse("invoke response does not match its operation or command");
    }
    return success.result;
  }

  async detach(): Promise<void> {
    const session = this.currentSession;
    this.currentSession = undefined;
    this.lastSnapshotSeq = undefined;
    this.lastEventSeq = undefined;
    if (!session) return;
    const response = await this.request(this.sessionRequest("detach", session));
    const success = this.unwrap(response);
    if (success.op !== "detach" || !success.detached) throw invalidResponse("detach request returned the wrong operation");
  }

  private async request(request: EngineControlRequestV1, timeoutMs = this.timeoutMs): Promise<EngineControlResponseV1> {
    try {
      return await requestEngineControl(this.options.socketPath, request, timeoutMs);
    } catch (error) {
      if (error instanceof EngineControlClientError) throw error;
      throw new EngineControlClientError(
        "UNAVAILABLE",
        error instanceof Error ? error.message : String(error),
        undefined,
        (error as NodeJS.ErrnoException | undefined)?.code,
      );
    }
  }

  private unwrap(response: EngineControlResponseV1): Exclude<EngineControlResponseV1, { ok: false }> {
    if (response.ok) return response;
    if (response.code === "SHELL_SESSION_INVALID") {
      this.currentSession = undefined;
      this.lastSnapshotSeq = undefined;
      this.lastEventSeq = undefined;
    }
    throw new EngineControlClientError("REMOTE", response.message, response.code);
  }

  private requireSession(): EngineShellSessionV1 {
    if (!this.currentSession) throw new EngineControlClientError("NOT_ATTACHED", "engine shell is not attached");
    return this.currentSession;
  }

  private sessionRequest(
    op: "touch" | "snapshot" | "detach",
    session: EngineShellSessionV1,
  ): EngineControlRequestV1 {
    return {
      schemaVersion: 1,
      op,
      workspaceHash: this.options.hello.workspaceHash,
      shellId: session.shellId,
      sessionToken: session.sessionToken,
    };
  }

  private assertSession(session: EngineShellSessionV1): void {
    if (session.shellId !== this.options.hello.shell.id) throw invalidResponse("session belongs to a different shell");
    this.assertEngineWorkspace(session.engine);
    if (session.protocol < this.options.hello.protocol.min || session.protocol > this.options.hello.protocol.max
      || session.protocol < session.engine.protocol.min || session.protocol > session.engine.protocol.max) {
      throw invalidResponse("session selected a protocol outside the negotiated ranges");
    }
  }

  private assertSameSession(next: EngineShellSessionV1, previous: EngineShellSessionV1): void {
    this.assertSession(next);
    if (next.sessionToken !== previous.sessionToken
      || next.engine.instanceId !== previous.engine.instanceId
      || next.engine.processStartIdentity !== previous.engine.processStartIdentity
      || next.engine.bridge.instanceId !== previous.engine.bridge.instanceId) {
      throw invalidResponse("shell session changed identity without a new attach");
    }
  }

  private assertEngineWorkspace(engine: EngineServiceIdentityV1): void {
    if (engine.workspaceHash !== this.options.hello.workspaceHash) throw invalidResponse("engine workspace hash mismatch");
    let expectedRoot: string;
    try {
      expectedRoot = fs.realpathSync(this.options.hello.workspaceRoot);
    } catch {
      throw invalidResponse("shell workspace root is unavailable");
    }
    if (engine.workspaceRoot !== expectedRoot) throw invalidResponse("engine canonical workspace root mismatch");
  }

  private assertMonotonic(seq: number): void {
    if (this.lastSnapshotSeq !== undefined && seq < this.lastSnapshotSeq) {
      throw invalidResponse("engine snapshot sequence moved backwards");
    }
    this.lastSnapshotSeq = seq;
  }
}

export function requestEngineControl(
  socketPath: string,
  request: EngineControlRequestV1,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
): Promise<EngineControlResponseV1> {
  return new Promise((resolve, reject) => {
    const maxResponseBytes = request.op === "query"
      ? request.query.method === "task.board"
        ? MISSION_CONTROL_RESPONSE_MAX_BYTES
        : request.query.method === "task.detail"
          ? TASK_DETAIL_RESPONSE_MAX_BYTES
          : request.query.method === "task.studio"
            ? TASK_STUDIO_RESPONSE_MAX_BYTES
            : request.query.method === "pin.studio"
              ? PIN_STUDIO_RESPONSE_MAX_BYTES
              : request.query.method === "handoff.view"
                ? HANDOFF_VIEW_RESPONSE_MAX_BYTES
          : MAX_CONTROL_RESPONSE_BYTES
      : MAX_CONTROL_RESPONSE_BYTES;
    const socket = net.createConnection(socketPath);
    let output = "";
    let settled = false;
    const finish = (result: { response: EngineControlResponseV1 } | { error: EngineControlClientError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if ("response" in result) resolve(result.response);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({ error: new EngineControlClientError("TIMEOUT", "engine control request timed out") }), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > maxResponseBytes) {
        finish({ error: invalidResponse("engine control response exceeds the size limit") });
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(output.slice(0, newline));
      } catch {
        finish({ error: invalidResponse("engine control response is not JSON") });
        return;
      }
      if (!isEngineControlResponseV1(parsed)) {
        finish({ error: invalidResponse("engine control response violates the protocol") });
        return;
      }
      finish({ response: parsed });
    });
    socket.once("error", (error) => {
      finish({
        error: new EngineControlClientError(
          "UNAVAILABLE",
          error.message,
          undefined,
          (error as NodeJS.ErrnoException).code,
        ),
      });
    });
    socket.once("end", () => {
      if (!settled) finish({ error: invalidResponse("engine control connection ended without a complete response") });
    });
  });
}

function invalidResponse(message: string): EngineControlClientError {
  return new EngineControlClientError("INVALID_RESPONSE", message);
}
