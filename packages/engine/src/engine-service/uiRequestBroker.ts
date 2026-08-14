import type { JsonValue } from "../runtime-api/extensionOperations.js";
import {
  isEngineUiCompletionV1,
  isEngineUiRequestV1,
  type EngineUiCompletionV1,
  type EngineUiRequestV1,
} from "./protocol.js";

export const ENGINE_UI_CAPABILITY = "tachyon.ui";
const DEFAULT_UI_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_UI_REQUESTS = 128;

export class EngineUiRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EngineUiRequestError";
  }
}

interface PendingUiRequest {
  request: EngineUiRequestV1;
  claimedBy?: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One in-process broker between the daemon and its ephemeral shells. Claim is atomic and never
 * reassigned after execution may have begun, so a lost completion cannot duplicate an editor action.
 */
export class EngineUiRequestBroker {
  private readonly shells = new Map<string, ReadonlySet<string>>();
  private readonly pending = new Map<string, PendingUiRequest>();
  private readonly order: string[] = [];
  private readonly timeoutMs: number;
  private closed = false;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_UI_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new Error("engine UI request timeout must be between 1 and 60000 ms");
    }
  }

  registerShell(shellId: string, capabilities: readonly string[]): void {
    if (this.closed) throw new EngineUiRequestError("UI_UNAVAILABLE", "engine UI broker is closed");
    this.shells.set(shellId, new Set(capabilities));
  }

  unregisterShell(shellId: string): void {
    if (!this.shells.delete(shellId)) return;
    for (const record of [...this.pending.values()]) {
      if (record.claimedBy === shellId) {
        this.fail(record, "UI_UNAVAILABLE", "the editor shell disconnected before confirming the UI operation");
      }
    }
    this.failUnserviceable();
  }

  request(requestInput: EngineUiRequestV1): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new EngineUiRequestError("UI_UNAVAILABLE", "engine UI broker is closed"));
    if (!isEngineUiRequestV1(requestInput)) {
      return Promise.reject(new EngineUiRequestError("INVALID_UI_REQUEST", "engine UI request is invalid"));
    }
    if (!this.hasEligibleShell()) {
      return Promise.reject(new EngineUiRequestError("UI_UNAVAILABLE", "no capable Tachyon editor shell is attached"));
    }
    if (this.pending.has(requestInput.operationId)) {
      return Promise.reject(new EngineUiRequestError("UI_OPERATION_CONFLICT", "engine UI operation id is already pending"));
    }
    if (this.pending.size >= MAX_PENDING_UI_REQUESTS) {
      return Promise.reject(new EngineUiRequestError("UI_CAPACITY", "engine UI request queue is full"));
    }
    const request = clone(requestInput);
    return new Promise<JsonValue>((resolve, reject) => {
      const record: PendingUiRequest = {
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(record, "UI_UNAVAILABLE", "editor UI operation timed out");
        }, this.timeoutMs),
      };
      record.timer.unref?.();
      this.pending.set(request.operationId, record);
      this.order.push(request.operationId);
    });
  }

  claim(shellId: string): EngineUiRequestV1 | null {
    if (!this.supportsUi(shellId)) return null;
    for (const operationId of this.order) {
      const record = this.pending.get(operationId);
      if (!record || record.claimedBy) continue;
      record.claimedBy = shellId;
      return clone(record.request);
    }
    return null;
  }

  complete(shellId: string, completionInput: EngineUiCompletionV1): string {
    if (!isEngineUiCompletionV1(completionInput)) {
      throw new EngineUiRequestError("INVALID_UI_COMPLETION", "engine UI completion is invalid");
    }
    const completion = clone(completionInput);
    const record = this.pending.get(completion.operationId);
    if (!record) throw new EngineUiRequestError("UI_REQUEST_MISSING", "engine UI request is missing or already completed");
    if (record.claimedBy !== shellId) {
      throw new EngineUiRequestError("UI_CLAIM_MISMATCH", "engine UI request is claimed by another shell");
    }
    this.remove(record);
    if (completion.status === "ok") record.resolve(completion.value);
    else record.reject(new EngineUiRequestError(completion.code, completion.message));
    return completion.operationId;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shells.clear();
    for (const record of [...this.pending.values()]) {
      this.fail(record, "UI_UNAVAILABLE", "engine UI broker closed before the operation completed");
    }
  }

  private supportsUi(shellId: string): boolean {
    return this.shells.get(shellId)?.has(ENGINE_UI_CAPABILITY) === true;
  }

  private hasEligibleShell(): boolean {
    return [...this.shells.keys()].some((shellId) => this.supportsUi(shellId));
  }

  private failUnserviceable(): void {
    if (this.hasEligibleShell()) return;
    for (const record of [...this.pending.values()]) {
      if (!record.claimedBy) this.fail(record, "UI_UNAVAILABLE", "no capable Tachyon editor shell remains attached");
    }
  }

  private fail(record: PendingUiRequest, code: string, message: string): void {
    this.remove(record);
    record.reject(new EngineUiRequestError(code, message));
  }

  private remove(record: PendingUiRequest): void {
    clearTimeout(record.timer);
    this.pending.delete(record.request.operationId);
    const index = this.order.indexOf(record.request.operationId);
    if (index >= 0) this.order.splice(index, 1);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
