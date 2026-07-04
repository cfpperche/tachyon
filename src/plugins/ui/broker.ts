import { randomBytes } from "node:crypto";
import type { PluginProjectionHandleMint, PluginProjectionTarget } from "./projectionBuilder.js";

export const PLUGIN_UI_ACTIONS = ["focusAgent"] as const;
export type PluginUiActionId = (typeof PLUGIN_UI_ACTIONS)[number];

export interface PluginActionTarget {
  wsHash?: string;
  agent: string;
}

export interface PluginActionBrokerOptions {
  pluginId: string;
  sessionId: string;
  allowedActions: Iterable<string>;
  focusAgent(target: PluginActionTarget): void | Promise<void>;
  minFocusIntervalMs?: number;
  now?: () => number;
  randomToken?: () => string;
}

export interface PluginUiActionRequest {
  handle?: unknown;
  action?: unknown;
  generation?: unknown;
  userGesture?: unknown;
  rateLimited?: unknown;
  [key: string]: unknown;
}

export type PluginActionBrokerErrorCode =
  | "malformed"
  | "raw_authority_rejected"
  | "unsupported_action"
  | "action_not_allowed"
  | "unknown_handle"
  | "stale_generation"
  | "user_gesture_required"
  | "rate_limited"
  | "callback_failed";

export type PluginActionBrokerResult =
  | { ok: true; action: PluginUiActionId; target: PluginActionTarget }
  | { ok: false; code: PluginActionBrokerErrorCode; reason: string };

export type PluginHandleResolveResult =
  | { ok: true; target: PluginActionTarget; generation: number }
  | { ok: false; code: "unknown_handle" | "stale_generation"; reason: string };

interface HandleRecord {
  pluginId: string;
  sessionId: string;
  target: PluginActionTarget;
  generation: number;
}

const DEFAULT_MIN_FOCUS_INTERVAL_MS = 750;
const RAW_AUTHORITY_FIELDS = new Set(["agent", "name", "wsHash", "folderHash", "workspace", "path", "worktree"]);

export class PluginActionBroker {
  private readonly handles = new Map<string, HandleRecord>();
  private readonly allowedActions: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly minFocusIntervalMs: number;
  private currentGeneration = 0;
  private lastFocusAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: PluginActionBrokerOptions) {
    this.allowedActions = new Set(opts.allowedActions);
    this.now = opts.now ?? Date.now;
    this.randomToken = opts.randomToken ?? defaultRandomToken;
    this.minFocusIntervalMs = opts.minFocusIntervalMs ?? DEFAULT_MIN_FOCUS_INTERVAL_MS;
  }

  mintHandle: PluginProjectionHandleMint = (target, generation) => {
    this.observeGeneration(generation);
    const handle = this.nextHandle();
    this.handles.set(handle, {
      pluginId: this.opts.pluginId,
      sessionId: this.opts.sessionId,
      target: targetFromProjection(target),
      generation,
    });
    return handle;
  };

  generation(): number {
    return this.currentGeneration;
  }

  bumpGeneration(next = this.currentGeneration + 1): number {
    if (!Number.isSafeInteger(next) || next < 0) throw new Error(`invalid plugin UI generation: ${next}`);
    this.currentGeneration = next;
    return this.currentGeneration;
  }

  resolveHandle(handle: string, generation = this.currentGeneration): PluginHandleResolveResult {
    const record = this.handles.get(handle);
    if (!record) return rejectResolve("unknown_handle", "Handle is unknown or revoked.");
    if (record.generation !== generation || generation !== this.currentGeneration) {
      return rejectResolve("stale_generation", "Handle generation is stale.");
    }
    return { ok: true, target: { ...record.target }, generation: record.generation };
  }

  expireHandle(handle: string): boolean {
    return this.handles.delete(handle);
  }

  expireAll(): void {
    this.handles.clear();
  }

  async dispatchAction(request: PluginUiActionRequest): Promise<PluginActionBrokerResult> {
    if (hasRawAuthority(request)) return reject("raw_authority_rejected", "Raw agent, workspace, hash, or path authority is not accepted.");
    if (typeof request.action !== "string" || typeof request.handle !== "string" || !Number.isSafeInteger(request.generation)) {
      return reject("malformed", "Action, handle, and generation are required.");
    }
    const generation = request.generation as number;
    if (!isPluginUiAction(request.action)) return reject("unsupported_action", "Only focusAgent is exposed to plugin UI.");
    if (!this.allowedActions.has(request.action)) return reject("action_not_allowed", "Plugin session is not consented for this action.");
    if (request.userGesture !== true) return reject("user_gesture_required", "focusAgent requires a user gesture.");
    if (request.rateLimited === true) return reject("rate_limited", "focusAgent was rate-limited by the host gate.");
    if (this.isFocusRateLimited()) return reject("rate_limited", "focusAgent is rate-limited.");

    const resolved = this.resolveHandle(request.handle, generation);
    if (!resolved.ok) return resolved;

    this.lastFocusAt = this.now();
    try {
      await this.opts.focusAgent(resolved.target);
    } catch (err) {
      return reject("callback_failed", err instanceof Error ? err.message : String(err));
    }
    return { ok: true, action: request.action, target: resolved.target };
  }

  private observeGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error(`invalid plugin UI generation: ${generation}`);
    if (generation > this.currentGeneration) this.currentGeneration = generation;
  }

  private nextHandle(): string {
    let handle = "";
    do {
      handle = `pui_${this.randomToken()}`;
    } while (this.handles.has(handle));
    return handle;
  }

  private isFocusRateLimited(): boolean {
    return this.now() - this.lastFocusAt < this.minFocusIntervalMs;
  }
}

function isPluginUiAction(action: string): action is PluginUiActionId {
  return (PLUGIN_UI_ACTIONS as readonly string[]).includes(action);
}

function targetFromProjection(target: PluginProjectionTarget): PluginActionTarget {
  return {
    ...(target.wsHash ? { wsHash: target.wsHash } : {}),
    agent: target.name,
  };
}

function hasRawAuthority(request: PluginUiActionRequest): boolean {
  return Object.keys(request).some((key) => RAW_AUTHORITY_FIELDS.has(key));
}

function reject(code: PluginActionBrokerErrorCode, reason: string): PluginActionBrokerResult {
  return { ok: false, code, reason };
}

function rejectResolve(code: "unknown_handle" | "stale_generation", reason: string): PluginHandleResolveResult {
  return { ok: false, code, reason };
}

function defaultRandomToken(): string {
  return randomBytes(18).toString("base64url");
}
