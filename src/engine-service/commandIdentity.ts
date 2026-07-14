import { createHash } from "node:crypto";
import type { WorkspaceCommandV1 } from "./protocol.js";

/** Stable identity for operation-id replay checks, independent of object key order. */
export function workspaceCommandFingerprint(command: WorkspaceCommandV1): string {
  return createHash("sha256")
    .update(canonicalJson(command))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
