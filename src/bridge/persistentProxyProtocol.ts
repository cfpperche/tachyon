import path from "node:path";

export const PERSISTENT_BRIDGE_PROTOCOL = 1;

export interface PersistentBridgeDescriptor {
  protocol: number;
  workspaceHash: string;
  workspaceRoot: string;
  instanceId: string;
  pid: number;
  port: number;
  controlSocket: string;
  startedAt: string;
}

export type PersistentBridgeControlRequest =
  | { op: "health"; workspaceHash: string }
  | { op: "register"; workspaceHash: string; backendPort: number }
  | { op: "detach"; workspaceHash: string; backendPort: number }
  | { op: "stop"; workspaceHash: string };

export type PersistentBridgeControlResponse =
  | { ok: true; descriptor: PersistentBridgeDescriptor; backendPort?: number }
  | { ok: false; code: string; message: string };

export function persistentBridgeDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "bridge-service");
}

export function persistentBridgeDescriptorPath(workspaceRoot: string): string {
  return path.join(persistentBridgeDir(workspaceRoot), "service.json");
}

export function persistentBridgeControlSocket(workspaceRoot: string): string {
  return path.join(persistentBridgeDir(workspaceRoot), "control.sock");
}

export function isPersistentBridgeDescriptor(value: unknown): value is PersistentBridgeDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<PersistentBridgeDescriptor>;
  return d.protocol === PERSISTENT_BRIDGE_PROTOCOL
    && typeof d.workspaceHash === "string"
    && typeof d.workspaceRoot === "string"
    && typeof d.instanceId === "string"
    && Number.isSafeInteger(d.pid) && (d.pid ?? 0) > 0
    && Number.isSafeInteger(d.port) && (d.port ?? 0) > 0 && (d.port ?? 0) <= 65_535
    && typeof d.controlSocket === "string"
    && typeof d.startedAt === "string";
}
