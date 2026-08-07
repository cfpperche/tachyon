/**
 * Shared wire shapes for the IDE Integrated Browser bridge (thimo-style).
 * Engine (client) and shell (server) share this contract — no vscode types here.
 */

export type IdeBrowserEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: string };

export type IdeBrowserStatus = {
  running: boolean;
  cdp: "disconnected" | "connecting" | "connected";
  transport: "websocket" | "none";
  url: string;
  endpoint: string;
  workspaceRoot: string;
  pid: number;
};

export type IdeBrowserInstanceFile = {
  schemaVersion: 2;
  kind: "tachyon-ide-browser";
  instanceId: string;
  workspaceRoot: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
};

export const IDE_BROWSER_INSTANCES_DIR_NAME = "ide-browser-instances";
export const IDE_BROWSER_INSTANCE_HEARTBEAT_MS = 5_000;
export const IDE_BROWSER_INSTANCE_FRESHNESS_MS = 30_000;
export const IDE_BROWSER_INSTANCE_HEADER = "x-tachyon-ide-browser-instance";
