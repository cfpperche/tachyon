import {
  isEngineOperationId,
  isWorkspaceEventV1,
  isWorkspaceCommandResultBoundToInput,
  isWorkspaceCommandResultV1,
  isWorkspaceCommandV1,
  isWorkspaceQueryResultBoundToInput,
  isWorkspaceQueryResultV1,
  isWorkspaceQueryV1,
  type EngineServiceIdentityV1,
  type WorkspaceCommandResultV1,
  type WorkspaceCommandV1,
  type WorkspaceQueryResultV1,
  type WorkspaceQueryV1,
  type WorkspaceEventV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "../engine-service/protocol.js";
import { workspaceCommandFingerprint } from "../engine-service/commandIdentity.js";
import {
  assertWorkspacePresentationIdentity,
  projectWorkspacePresentation,
  type WorkspacePresentationSnapshotV1,
} from "../runtime-api/workspaceProjection.js";
import { createHash } from "node:crypto";
import type { StagedPayloadRefV1 } from "../runtime-api/stagedPayload.js";
import {
  type WorkspaceClient,
  type WorkspaceClientListener,
  type WorkspaceClientSyncResult,
  type WorkspaceStagedPayload,
} from "./WorkspaceClient.js";

export interface FakeWorkspaceClientOptions {
  identity: EngineServiceIdentityV1;
  snapshot: WorkspaceSnapshotEnvelopeV1;
  invoke?: (
    operationId: string,
    command: WorkspaceCommandV1,
  ) => WorkspaceCommandResultV1 | Promise<WorkspaceCommandResultV1>;
  query?: (query: WorkspaceQueryV1) => WorkspaceQueryResultV1 | Promise<WorkspaceQueryResultV1>;
}

interface QueuedSync {
  identity: EngineServiceIdentityV1;
  snapshot: WorkspaceSnapshotEnvelopeV1;
  events: WorkspaceEventV1[];
  resynced: boolean;
  engineChanged: boolean;
}

interface FakeOperation {
  fingerprint: string;
  promise: Promise<WorkspaceCommandResultV1>;
}

export class FakeWorkspaceClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FakeWorkspaceClientError";
  }
}

/** Deterministic, Node-only WorkspaceClient for presentation tests. */
export class FakeWorkspaceClient implements WorkspaceClient {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly invocations: Array<{ operationId: string; command: WorkspaceCommandV1 }> = [];
  readonly queries: WorkspaceQueryV1[] = [];
  readonly stagedPayloads: Array<{ ref: StagedPayloadRefV1; data: Buffer; discarded: boolean }> = [];
  private readonly listeners = new Set<WorkspaceClientListener>();
  private readonly queued: QueuedSync[] = [];
  private readonly operations = new Map<string, FakeOperation>();
  private currentIdentity: EngineServiceIdentityV1;
  private currentSnapshot: WorkspaceSnapshotEnvelopeV1;
  private currentPresentation: WorkspacePresentationSnapshotV1;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private stagedPayloadSequence = 0;

  constructor(private readonly options: FakeWorkspaceClientOptions) {
    this.currentIdentity = cloneJson(options.identity);
    this.workspaceRoot = options.identity.workspaceRoot;
    this.workspaceHash = options.identity.workspaceHash;
    this.currentSnapshot = cloneJson(options.snapshot);
    this.currentPresentation = this.validateSnapshot(options.snapshot, options.identity);
  }

  get identity(): EngineServiceIdentityV1 {
    return cloneJson(this.currentIdentity);
  }

  get snapshot(): WorkspaceSnapshotEnvelopeV1 {
    return cloneJson(this.currentSnapshot);
  }

  get presentation(): WorkspacePresentationSnapshotV1 {
    return cloneJson(this.currentPresentation);
  }

  get bridgeUrl(): string {
    return `http://127.0.0.1:${this.currentIdentity.bridge.port}/mcp`;
  }

  async engineLogTail(): Promise<string[]> {
    return [];
  }

  async engineLogHealth(): Promise<{
    logTail: string[];
    logBySource: { daemon: string[]; events?: string[]; bridge?: string[] };
    logHasError: boolean;
  }> {
    return { logTail: [], logBySource: { daemon: [] }, logHasError: false };
  }

  async clearEngineLog(): Promise<void> {}

  get isClosed(): boolean {
    return this.closed;
  }

  enqueueSync(update: {
    snapshot: WorkspaceSnapshotEnvelopeV1;
    events?: WorkspaceEventV1[];
    resynced?: boolean;
    engineChanged?: boolean;
    identity?: EngineServiceIdentityV1;
  }): void {
    this.requireOpen();
    const prior = this.queued[this.queued.length - 1];
    const priorIdentity = prior?.identity ?? this.currentIdentity;
    const priorSnapshot = prior?.snapshot ?? this.currentSnapshot;
    const identity = update.identity ?? priorIdentity;
    this.validateSnapshot(update.snapshot, identity);
    const identityChanged = !sameIncarnation(priorIdentity, identity);
    if (!identityChanged && update.snapshot.seq < priorSnapshot.seq) {
      throw new FakeWorkspaceClientError("INVALID_SNAPSHOT", "same-engine snapshot sequence moved backwards");
    }
    if (update.engineChanged !== undefined && update.engineChanged !== identityChanged) {
      throw new FakeWorkspaceClientError("INVALID_SNAPSHOT", "engineChanged contradicts the queued engine identity");
    }
    const events = update.events ?? [];
    if (events.length > 200 || events.some((event) => !isWorkspaceEventV1(event)
      || event.engineInstanceId !== identity.instanceId
      || event.seq > update.snapshot.seq)) {
      throw new FakeWorkspaceClientError("INVALID_EVENTS", "queued workspace events are invalid for the snapshot");
    }
    this.queued.push({
      identity: cloneJson(identity),
      snapshot: cloneJson(update.snapshot),
      events: cloneJson(events),
      resynced: update.resynced ?? false,
      engineChanged: identityChanged,
    });
  }

  async sync(limit = 100): Promise<WorkspaceClientSyncResult> {
    this.requireOpen();
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      throw new FakeWorkspaceClientError("INVALID_SYNC_LIMIT", "event sync limit must be between 1 and 200");
    }
    const next = this.queued.shift();
    if (!next) return this.result([], false, false);
    this.currentPresentation = this.validateSnapshot(next.snapshot, next.identity);
    this.currentIdentity = cloneJson(next.identity);
    this.currentSnapshot = cloneJson(next.snapshot);
    const result = this.result(next.events, next.resynced, next.engineChanged);
    for (const listener of this.listeners) {
      try { listener(cloneJson(result)); } catch { /* match the real client: one panel cannot break sync */ }
    }
    return result;
  }

  async query(query: WorkspaceQueryV1): Promise<WorkspaceQueryResultV1> {
    this.requireOpen();
    if (!isWorkspaceQueryV1(query)) {
      throw new FakeWorkspaceClientError("INVALID_QUERY", "workspace query is invalid");
    }
    const cloned = cloneJson(query);
    this.queries.push(cloned);
    if (!this.options.query) return queryError(query, "UNSUPPORTED_OPERATION", "fake query handler is unavailable");
    try {
      const result = await this.options.query(cloned);
      if (!isWorkspaceQueryResultV1(result)
        || !isWorkspaceQueryResultBoundToInput(query, result)) {
        return queryError(query, "INVALID_QUERY_RESULT", "fake query handler returned an invalid result");
      }
      return cloneJson(result);
    } catch (error) {
      return queryError(query, "QUERY_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  invoke(operationId: string, command: WorkspaceCommandV1): Promise<WorkspaceCommandResultV1> {
    try { this.requireOpen(); }
    catch (error) { return Promise.reject(error); }
    if (!isEngineOperationId(operationId)) {
      return Promise.reject(new FakeWorkspaceClientError("INVALID_COMMAND", `workspace operation id is invalid: ${operationId}`));
    }
    if (!isWorkspaceCommandV1(command)) {
      return Promise.reject(new FakeWorkspaceClientError("INVALID_COMMAND", "workspace command is invalid"));
    }
    const fingerprint = workspaceCommandFingerprint(command);
    const existing = this.operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(commandError(command, "OPERATION_ID_CONFLICT", "operation id already has a different command"));
      }
      return existing.promise;
    }
    this.invocations.push({ operationId, command: cloneJson(command) });
    const promise = Promise.resolve().then(async () => {
      if (!this.options.invoke) return commandError(command, "UNSUPPORTED_OPERATION", "fake command handler is unavailable");
      try {
        const result = await this.options.invoke(operationId, cloneJson(command));
        if (!isWorkspaceCommandResultV1(result) || !isWorkspaceCommandResultBoundToInput(command, result)) {
          return commandError(command, "INVALID_COMMAND_RESULT", "fake command handler returned an invalid result");
        }
        return cloneJson(result);
      } catch (error) {
        return commandError(command, "COMMAND_FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    this.operations.set(operationId, { fingerprint, promise });
    return promise;
  }

  stagePayload(data: Buffer): WorkspaceStagedPayload {
    this.requireOpen();
    if (!Buffer.isBuffer(data) || data.byteLength <= 0) {
      throw new FakeWorkspaceClientError("INVALID_PAYLOAD", "fake staged payload must be a non-empty Buffer");
    }
    const ref: StagedPayloadRefV1 = {
      schemaVersion: 1,
      token: (++this.stagedPayloadSequence).toString(16).padStart(48, "0"),
      sha256: createHash("sha256").update(data).digest("hex"),
      byteSize: data.byteLength,
    };
    const record = { ref, data: Buffer.from(data), discarded: false };
    this.stagedPayloads.push(record);
    return {
      ref,
      discard: () => { record.discarded = true; },
    };
  }

  subscribe(listener: WorkspaceClientListener): () => void {
    this.requireOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listeners.clear();
    this.closePromise = Promise.resolve();
    return this.closePromise;
  }

  private validateSnapshot(
    snapshot: WorkspaceSnapshotEnvelopeV1,
    identity: EngineServiceIdentityV1,
  ): WorkspacePresentationSnapshotV1 {
    const presentation = projectWorkspacePresentation(snapshot);
    assertWorkspacePresentationIdentity(presentation, {
      workspaceRoot: this.workspaceRoot,
      workspaceHash: this.workspaceHash,
      engineInstanceId: identity.instanceId,
      bridgeInstanceId: identity.bridge.instanceId,
      bridgePort: identity.bridge.port,
    });
    return presentation;
  }

  private result(events: WorkspaceEventV1[], resynced: boolean, engineChanged: boolean): WorkspaceClientSyncResult {
    return {
      snapshot: cloneJson(this.currentSnapshot),
      events: cloneJson(events),
      resynced,
      engineChanged,
    };
  }

  private requireOpen(): void {
    if (this.closed) throw new FakeWorkspaceClientError("CLIENT_CLOSED", "workspace client is closed");
  }
}

function commandError(command: WorkspaceCommandV1, code: string, message: string): WorkspaceCommandResultV1 {
  return {
    schemaVersion: 1,
    method: command.method,
    status: "error",
    code,
    message: message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "fake command failed",
  };
}

function queryError(query: WorkspaceQueryV1, code: string, message: string): WorkspaceQueryResultV1 {
  return {
    schemaVersion: 1,
    method: query.method,
    status: "error",
    code,
    message: message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "fake query failed",
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameIncarnation(left: EngineServiceIdentityV1, right: EngineServiceIdentityV1): boolean {
  return left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.bundleId === right.bundleId
    && left.bridge.instanceId === right.bridge.instanceId
    && left.bridge.port === right.bridge.port;
}
