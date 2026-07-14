import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { EngineControlClient, EngineControlClientError } from "../engine-service/controlClient.js";
import {
  stagePackagedEngineBundle,
  type StagedEngineBundle,
} from "../engine-service/engineBundleStore.js";
import {
  ensureDaemonEngine,
  type EnsureDaemonEngineOptions,
  type EnsuredDaemonEngine,
} from "../engine-service/engineSupervisor.js";
import {
  ENGINE_SHELL_PROTOCOL,
  isEngineOperationId,
  isWorkspaceCommandV1,
  type EngineServiceIdentityV1,
  type EngineShellHelloV1,
  type WorkspaceEventV1,
  type WorkspaceCommandResultV1,
  type WorkspaceCommandV1,
  type WorkspaceSnapshotEnvelopeV1,
} from "../engine-service/protocol.js";
import { workspaceHash } from "../tmux/TmuxService.js";
import type { DaemonSettingsSnapshot } from "../workspace/DaemonEngineHost.js";
import {
  assertWorkspacePresentationIdentity,
  projectWorkspacePresentation,
  type WorkspacePresentationSnapshotV1,
} from "../runtime-api/workspaceProjection.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_ATTACH_RACE_ATTEMPTS = 2;

export interface WorkspaceClientSyncResult {
  snapshot: WorkspaceSnapshotEnvelopeV1;
  events: WorkspaceEventV1[];
  /** The event cursor was invalid/expired, so the result came from a full snapshot. */
  resynced: boolean;
  /** A real engine incarnation changed while recovering this shell connection. */
  engineChanged: boolean;
}

export type WorkspaceClientListener = (result: WorkspaceClientSyncResult) => void;

export interface WorkspaceClient {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  readonly identity: EngineServiceIdentityV1;
  readonly snapshot: WorkspaceSnapshotEnvelopeV1;
  readonly presentation: WorkspacePresentationSnapshotV1;
  readonly bridgeUrl: string;
  sync(limit?: number): Promise<WorkspaceClientSyncResult>;
  invoke(operationId: string, command: WorkspaceCommandV1): Promise<WorkspaceCommandResultV1>;
  subscribe(listener: WorkspaceClientListener): () => void;
  /** Detaches only this shell lease.  It never stops, restarts or disposes the engine. */
  close(): Promise<void>;
}

type EnsureEngine = (options: EnsureDaemonEngineOptions) => Promise<EnsuredDaemonEngine>;

export interface ConnectRemoteWorkspaceClientOptions {
  workspaceRoot: string;
  bundle: StagedEngineBundle;
  shell: {
    id?: string;
    version: string;
    locale: string;
  };
  capabilities?: string[];
  settings?: DaemonSettingsSnapshot;
  supervisor?: Omit<EnsureDaemonEngineOptions, "workspaceRoot" | "bundle" | "settings">;
  /** Deterministic test/platform seam; production uses ensureDaemonEngine. */
  ensure?: EnsureEngine;
}

export interface ConnectPackagedWorkspaceClientOptions extends Omit<ConnectRemoteWorkspaceClientOptions, "bundle"> {
  extensionRoot: string;
  bundleInstallRoot?: string;
  /** Test/local-build override. Installed production bundles remain clean-only. */
  requireCleanBuild?: boolean;
}

export class RemoteWorkspaceClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteWorkspaceClientError";
  }
}

/** Zero-step installed-shell entrypoint: verify/stage the shipped engine, ensure it, then attach. */
export async function connectPackagedWorkspaceClient(
  options: ConnectPackagedWorkspaceClientOptions,
): Promise<RemoteWorkspaceClient> {
  const { extensionRoot, bundleInstallRoot, requireCleanBuild, ...clientOptions } = options;
  const bundle = stagePackagedEngineBundle({
    extensionRoot,
    installRoot: bundleInstallRoot,
    requireCleanBuild,
  });
  return connectRemoteWorkspaceClient({ ...clientOptions, bundle });
}

export async function connectRemoteWorkspaceClient(
  options: ConnectRemoteWorkspaceClientOptions,
): Promise<RemoteWorkspaceClient> {
  return RemoteWorkspaceClient.create(options);
}

/**
 * Plain Node shell adapter.  It owns one ephemeral authenticated shell lease and a cached projection;
 * every operational object remains in the daemon.  Recovery always re-runs the supervisor identity
 * proof, and detach is deliberately incapable of stopping the service.
 */
export class RemoteWorkspaceClient implements WorkspaceClient {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  private readonly hello: EngineShellHelloV1;
  private readonly ensureEngine: EnsureEngine;
  private readonly ensureOptions: EnsureDaemonEngineOptions;
  private readonly listeners = new Set<WorkspaceClientListener>();
  private control!: EngineControlClient;
  private currentIdentity!: EngineServiceIdentityV1;
  private currentSnapshot!: WorkspaceSnapshotEnvelopeV1;
  private currentPresentation!: WorkspacePresentationSnapshotV1;
  private tail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closeRequested = false;

  private constructor(options: ConnectRemoteWorkspaceClientOptions) {
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.workspaceHash = workspaceHash(this.workspaceRoot);
    const shellId = options.shell.id ?? randomUUID();
    if (shellId.length < 8 || shellId.length > 128) throw new RemoteWorkspaceClientError("INVALID_SHELL", "shell id must be 8-128 characters");
    if (typeof options.shell.version !== "string" || typeof options.shell.locale !== "string"
      || !options.shell.version.trim() || options.shell.version.length > 128
      || !options.shell.locale.trim() || options.shell.locale.length > 128) {
      throw new RemoteWorkspaceClientError("INVALID_SHELL", "shell version and locale are required");
    }
    const capabilities = [...(options.capabilities ?? [])].sort();
    if (capabilities.some((value) => typeof value !== "string" || !value || value.length > 128)
      || new Set(capabilities).size !== capabilities.length) {
      throw new RemoteWorkspaceClientError("INVALID_SHELL", "shell capabilities must be unique bounded strings");
    }
    const settingsDigest = digestSettings(options.settings);
    const settings = options.settings === undefined ? undefined : cloneJson(options.settings);
    this.hello = {
      schemaVersion: 1,
      op: "attach",
      workspaceRoot: this.workspaceRoot,
      workspaceHash: this.workspaceHash,
      shell: { id: shellId, version: options.shell.version, locale: options.shell.locale },
      protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
      capabilities,
      settingsDigest,
    };
    this.ensureEngine = options.ensure ?? ensureDaemonEngine;
    this.ensureOptions = {
      ...options.supervisor,
      workspaceRoot: this.workspaceRoot,
      bundle: { ...options.bundle },
      settings,
    };
  }

  static async create(options: ConnectRemoteWorkspaceClientOptions): Promise<RemoteWorkspaceClient> {
    const client = new RemoteWorkspaceClient(options);
    await client.initialize();
    return client;
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

  sync(limit = DEFAULT_EVENT_LIMIT): Promise<WorkspaceClientSyncResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      return Promise.reject(new RemoteWorkspaceClientError("INVALID_SYNC_LIMIT", "event sync limit must be between 1 and 200"));
    }
    if (this.closeRequested) return Promise.reject(new RemoteWorkspaceClientError("CLIENT_CLOSED", "workspace client is closed"));
    const result = this.tail.then(() => this.syncOnce(limit));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  invoke(operationId: string, command: WorkspaceCommandV1): Promise<WorkspaceCommandResultV1> {
    if (!isEngineOperationId(operationId) || !isWorkspaceCommandV1(command)) {
      return Promise.reject(new RemoteWorkspaceClientError("INVALID_COMMAND", "workspace command or operation id is invalid"));
    }
    if (this.closeRequested) return Promise.reject(new RemoteWorkspaceClientError("CLIENT_CLOSED", "workspace client is closed"));
    const result = this.tail.then(() => this.invokeOnce(operationId, command));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  subscribe(listener: WorkspaceClientListener): () => void {
    if (this.closeRequested) throw new RemoteWorkspaceClientError("CLIENT_CLOSED", "workspace client is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.tail.then(async () => {
      this.listeners.clear();
      try { await this.control.detach(); }
      catch (error) {
        if (!isExpectedDetachLoss(error)) throw error;
      }
    });
    this.tail = this.closePromise.then(() => undefined, () => undefined);
    return this.closePromise;
  }

  private async initialize(): Promise<void> {
    if (this.closeRequested) throw new RemoteWorkspaceClientError("CLIENT_CLOSED", "workspace client is closed");
    const attached = await this.attachVerified();
    this.control = attached.control;
    this.currentIdentity = attached.identity;
    this.currentSnapshot = cloneJson(attached.snapshot);
    this.currentPresentation = attached.presentation;
  }

  private async syncOnce(limit: number): Promise<WorkspaceClientSyncResult> {
    try {
      const batch = await this.control.events(limit);
      if (batch.events.length === 0 && !batch.resyncRequired) {
        return this.result([], false, false);
      }
      this.acceptSnapshot(await this.control.snapshot(), this.currentIdentity);
      const result = this.result(batch.events, batch.resyncRequired, false);
      this.emit(result);
      return result;
    } catch (error) {
      if (!isRecoverableConnectionLoss(error)) throw error;
      return this.reconnect();
    }
  }

  private async reconnect(): Promise<WorkspaceClientSyncResult> {
    const previous = this.currentIdentity;
    const attached = await this.attachVerified();
    this.control = attached.control;
    this.currentIdentity = attached.identity;
    this.currentSnapshot = cloneJson(attached.snapshot);
    this.currentPresentation = attached.presentation;
    const result = this.result([], true, !sameIncarnation(previous, attached.identity));
    this.emit(result);
    return result;
  }

  private async invokeOnce(operationId: string, command: WorkspaceCommandV1): Promise<WorkspaceCommandResultV1> {
    try {
      return await this.control.invoke(operationId, command);
    } catch (error) {
      if (isRejectedBeforeInvocation(error)) {
        await this.reconnect();
        try {
          return await this.control.invoke(operationId, command);
        } catch (retryError) {
          if (isAmbiguousInvokeTransport(retryError)) {
            await this.reconnect().catch(() => undefined);
            throw unknownOperationOutcome(operationId);
          }
          throw retryError;
        }
      }
      if (isAmbiguousInvokeTransport(error)) {
        await this.reconnect().catch(() => undefined);
        throw unknownOperationOutcome(operationId);
      }
      throw error;
    }
  }

  private async attachVerified(): Promise<{
    control: EngineControlClient;
    identity: EngineServiceIdentityV1;
    snapshot: WorkspaceSnapshotEnvelopeV1;
    presentation: WorkspacePresentationSnapshotV1;
  }> {
    for (let attempt = 1; attempt <= MAX_ATTACH_RACE_ATTEMPTS; attempt += 1) {
      const ensured = await this.ensureEngine(this.ensureOptions);
      const control = new EngineControlClient({ socketPath: ensured.controlSocketPath, hello: this.hello });
      try {
        const session = await control.attach();
        if (!sameIncarnation(ensured.identity, session.engine)) {
          await control.detach().catch(() => undefined);
          continue;
        }
        const snapshot = await control.snapshot();
        const presentation = this.validatePresentation(snapshot, session.engine);
        return { control, identity: session.engine, snapshot, presentation };
      } catch (error) {
        await control.detach().catch(() => undefined);
        if (attempt < MAX_ATTACH_RACE_ATTEMPTS && isRecoverableConnectionLoss(error)) continue;
        throw error;
      }
    }
    throw new RemoteWorkspaceClientError(
      "ENGINE_ATTACH_RACE",
      "persistent engine identity changed repeatedly between verification and shell attach",
    );
  }

  private acceptSnapshot(snapshot: WorkspaceSnapshotEnvelopeV1, identity: EngineServiceIdentityV1): void {
    const presentation = this.validatePresentation(snapshot, identity);
    this.currentSnapshot = cloneJson(snapshot);
    this.currentPresentation = presentation;
  }

  private validatePresentation(
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

  private emit(result: WorkspaceClientSyncResult): void {
    for (const listener of this.listeners) {
      try { listener(cloneJson(result)); } catch { /* one presentation subscriber cannot break sync */ }
    }
  }
}

function isRecoverableConnectionLoss(error: unknown): boolean {
  return error instanceof EngineControlClientError
    && (error.code === "UNAVAILABLE"
      || error.code === "TIMEOUT"
      || (error.code === "REMOTE" && error.remoteCode === "SHELL_SESSION_INVALID"));
}

function isRejectedBeforeInvocation(error: unknown): boolean {
  return error instanceof EngineControlClientError
    && error.code === "REMOTE"
    && error.remoteCode === "SHELL_SESSION_INVALID";
}

function isAmbiguousInvokeTransport(error: unknown): boolean {
  return error instanceof EngineControlClientError
    && (error.code === "UNAVAILABLE" || error.code === "TIMEOUT" || error.code === "INVALID_RESPONSE");
}

function unknownOperationOutcome(operationId: string): RemoteWorkspaceClientError {
  return new RemoteWorkspaceClientError(
    "OPERATION_OUTCOME_UNKNOWN",
    `engine connection was lost after operation '${operationId}' was sent; Tachyon will not repeat it automatically`,
  );
}

function isExpectedDetachLoss(error: unknown): boolean {
  return isRecoverableConnectionLoss(error)
    || (error instanceof EngineControlClientError
      && error.code === "REMOTE"
      && error.remoteCode === "SHELL_SESSION_INVALID");
}

function sameIncarnation(left: EngineServiceIdentityV1, right: EngineServiceIdentityV1): boolean {
  return left.instanceId === right.instanceId
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.bundleId === right.bundleId
    && left.bridge.instanceId === right.bridge.instanceId
    && left.bridge.port === right.bridge.port;
}

function digestSettings(settings: DaemonSettingsSnapshot | undefined): string {
  if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings))) {
    throw new RemoteWorkspaceClientError("INVALID_SETTINGS", "daemon settings must be a plain JSON object");
  }
  return createHash("sha256").update(canonicalJson(settings ?? {})).digest("hex");
}

function canonicalJson(value: unknown): string {
  const normalized = normalizeJson(value);
  return JSON.stringify(normalized);
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RemoteWorkspaceClientError("INVALID_SETTINGS", "daemon settings must contain only plain JSON objects");
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)]));
  }
  throw new RemoteWorkspaceClientError("INVALID_SETTINGS", "daemon settings must be finite JSON values");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
