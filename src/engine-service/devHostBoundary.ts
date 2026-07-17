import fs from "node:fs";
import path from "node:path";

export const DEV_HOST_MARKER = ".tachyon-dev-host.json";
const MAX_MARKER_BYTES = 4 * 1024;

export type EngineShellMode = "production" | "development" | "test";

export interface EngineShellReleasePolicy {
  requiredChannel: "stable" | "dev";
  requireCleanBuild: boolean;
  requireMarkedDevHost: boolean;
}

/** Keep installed, Dev Host and test engine boundaries explicit and independently testable. */
export function engineShellReleasePolicy(mode: EngineShellMode): EngineShellReleasePolicy {
  if (mode === "production") {
    return { requiredChannel: "stable", requireCleanBuild: true, requireMarkedDevHost: false };
  }
  return {
    requiredChannel: "dev",
    requireCleanBuild: false,
    requireMarkedDevHost: mode === "development",
  };
}

export class DevHostBoundaryError extends Error {
  constructor(readonly code: "DEV_HOST_MARKER_MISSING" | "DEV_HOST_MARKER_INVALID", message: string) {
    super(message);
    this.name = "DevHostBoundaryError";
  }
}

/** Development extensions are allowed to supervise engines only inside an explicitly materialized fixture. */
export function assertMarkedDevHostWorkspace(workspaceRoot: string): void {
  const root = fs.realpathSync(workspaceRoot);
  const marker = path.join(root, DEV_HOST_MARKER);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(marker); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DevHostBoundaryError(
        "DEV_HOST_MARKER_MISSING",
        "Tachyon development builds run only in a marked Dev Host workspace; arm it with npm run dogfood:dev-host -- point",
      );
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MARKER_BYTES) {
    throw new DevHostBoundaryError("DEV_HOST_MARKER_INVALID", "Tachyon Dev Host workspace marker is unsafe or invalid");
  }
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(marker, "utf8")); }
  catch { throw new DevHostBoundaryError("DEV_HOST_MARKER_INVALID", "Tachyon Dev Host workspace marker is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== 1
    || (value as Record<string, unknown>).kind !== "tachyon-dev-host"
    || Object.keys(value as Record<string, unknown>).some((key) => key !== "schemaVersion" && key !== "kind")) {
    throw new DevHostBoundaryError("DEV_HOST_MARKER_INVALID", "Tachyon Dev Host workspace marker has an unsupported shape");
  }
}
