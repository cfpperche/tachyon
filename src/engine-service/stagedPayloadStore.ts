import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ensureSecureRuntimeDir } from "../bridge/persistentProxyProtocol.js";
import {
  isStagedPayloadRefV1,
  type StagedPayloadRefV1,
} from "../runtime-api/stagedPayload.js";

export const MAX_STAGED_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const STAGED_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1_000;

export class StagedPayloadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StagedPayloadError";
  }
}

/**
 * Shared-filesystem transport for command payloads that do not belong in the bounded JSON control socket.
 * The directory is private to the current user.  Every read is fd-bound (`O_NOFOLLOW` + `fstat`) and the
 * command-supplied digest is verified over those exact bytes before the file is unlinked by inode identity.
 */
export class StagedPayloadStore {
  readonly directory: string;

  constructor(runtimeDirectory: string) {
    ensureSecureRuntimeDir(runtimeDirectory);
    this.directory = path.join(runtimeDirectory, "payloads");
    ensureSecureRuntimeDir(this.directory);
  }

  stage(data: Buffer): StagedPayloadRefV1 {
    if (!Buffer.isBuffer(data) || data.byteLength <= 0 || data.byteLength > MAX_STAGED_PAYLOAD_BYTES) {
      throw new StagedPayloadError(
        "PAYLOAD_SIZE",
        `staged payload must contain 1-${MAX_STAGED_PAYLOAD_BYTES} bytes`,
      );
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const token = randomBytes(24).toString("hex");
      const file = this.fileForToken(token);
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
        return { schemaVersion: 1, token, sha256, byteSize: data.byteLength };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        try { fs.unlinkSync(file); } catch { /* best effort; identity is random and exclusive */ }
        throw error;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    throw new StagedPayloadError("TOKEN_COLLISION", "could not mint a unique staged payload token");
  }

  consume(ref: StagedPayloadRefV1, maxBytes = MAX_STAGED_PAYLOAD_BYTES): Buffer {
    this.assertRef(ref, maxBytes);
    const file = this.fileForToken(ref.token);
    let fd: number | undefined;
    let opened: fs.Stats | undefined;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      opened = fs.fstatSync(fd);
      this.assertOpenedFile(opened, ref);
      const data = Buffer.allocUnsafe(ref.byteSize);
      let offset = 0;
      while (offset < data.byteLength) {
        const read = fs.readSync(fd, data, offset, data.byteLength - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== data.byteLength) {
        throw new StagedPayloadError("PAYLOAD_TRUNCATED", "staged payload ended before its declared size");
      }
      const after = fs.fstatSync(fd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new StagedPayloadError("PAYLOAD_CHANGED", "staged payload identity changed while it was read");
      }
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== ref.sha256) {
        throw new StagedPayloadError("PAYLOAD_HASH", "staged payload digest does not match its command reference");
      }
      return data;
    } catch (error) {
      if (error instanceof StagedPayloadError) throw error;
      throw new StagedPayloadError(
        "PAYLOAD_UNAVAILABLE",
        `staged payload is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (opened) this.unlinkIfIdentity(file, opened);
    }
  }

  discard(ref: StagedPayloadRefV1): void {
    if (!isStagedPayloadRefV1(ref)) return;
    const file = this.fileForToken(ref.token);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { return; }
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    this.unlinkIfIdentity(file, stat);
  }

  cleanupStale(now = Date.now(), maxAgeMs = STAGED_PAYLOAD_MAX_AGE_MS): number {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
      throw new StagedPayloadError("INVALID_MAX_AGE", "staged payload max age must be a positive integer");
    }
    let entries: string[];
    try { entries = fs.readdirSync(this.directory); } catch { return 0; }
    let removed = 0;
    for (const token of entries) {
      if (!/^[a-f0-9]{48}$/.test(token)) continue;
      const file = this.fileForToken(token);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || now - stat.mtimeMs < maxAgeMs) continue;
      if (this.unlinkIfIdentity(file, stat)) removed += 1;
    }
    return removed;
  }

  private assertRef(ref: StagedPayloadRefV1, maxBytes: number): void {
    if (!isStagedPayloadRefV1(ref)) {
      throw new StagedPayloadError("INVALID_PAYLOAD_REF", "staged payload reference is invalid");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_STAGED_PAYLOAD_BYTES) {
      throw new StagedPayloadError("INVALID_PAYLOAD_LIMIT", "staged payload limit is invalid");
    }
    if (ref.byteSize > maxBytes) {
      throw new StagedPayloadError("PAYLOAD_SIZE", `staged payload exceeds the ${maxBytes}-byte operation limit`);
    }
  }

  private assertOpenedFile(stat: fs.Stats, ref: StagedPayloadRefV1): void {
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile()) throw new StagedPayloadError("PAYLOAD_TYPE", "staged payload is not a regular file");
    if (stat.uid !== uid) throw new StagedPayloadError("PAYLOAD_OWNER", "staged payload has a foreign owner");
    if ((stat.mode & 0o077) !== 0) throw new StagedPayloadError("PAYLOAD_MODE", "staged payload is group/other-accessible");
    if (stat.nlink !== 1) throw new StagedPayloadError("PAYLOAD_LINKS", "staged payload must have exactly one link");
    if (stat.size !== ref.byteSize) throw new StagedPayloadError("PAYLOAD_SIZE", "staged payload size does not match its command reference");
  }

  private fileForToken(token: string): string {
    if (!/^[a-f0-9]{48}$/.test(token)) throw new StagedPayloadError("INVALID_PAYLOAD_TOKEN", "staged payload token is invalid");
    return path.join(this.directory, token);
  }

  private unlinkIfIdentity(file: string, expected: fs.Stats): boolean {
    let current: fs.Stats;
    try { current = fs.lstatSync(file); } catch { return false; }
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== expected.dev || current.ino !== expected.ino) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }
}
