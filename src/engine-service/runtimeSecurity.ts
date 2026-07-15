import fs from "node:fs";

/** Conservative cross-platform budget for an AF_UNIX socket path, including its terminator. */
export const MAX_CONTROL_SOCKET_PATH_BYTES = 100;

export class UnsafeRuntimeDirectoryError extends Error {
  constructor(readonly dirPath: string, readonly reason: string) {
    super(`runtime directory is unsafe, refusing to use it: ${dirPath} (${reason})`);
    this.name = "UnsafeRuntimeDirectoryError";
  }
}

/**
 * Creates or reuses an owner-private real directory. Existing symlinks, foreign ownership and
 * group/other access are refused rather than repaired in place.
 */
export function ensureSecureRuntimeDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory()) {
    throw new UnsafeRuntimeDirectoryError(dirPath, "not a real directory (symlink or other non-directory entry)");
  }
  if (stat.uid !== uid) {
    throw new UnsafeRuntimeDirectoryError(dirPath, `owned by uid ${stat.uid}, expected ${uid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UnsafeRuntimeDirectoryError(
      dirPath,
      `mode ${(stat.mode & 0o777).toString(8)} is group/other-accessible`,
    );
  }
}
