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
  schemaVersion: 1;
  kind: "tachyon-ide-browser";
  workspaceRoot: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
};

export const IDE_BROWSER_INSTANCES_DIR_NAME = "ide-browser-instances";
