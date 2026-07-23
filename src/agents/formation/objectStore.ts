import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const ABANDONED_STAGING_AGE_MS = 24 * 60 * 60 * 1000;

export class FormationObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormationObjectStoreError";
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function assertPrivateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== path.resolve(directory)
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new FormationObjectStoreError(`formation object-store path is not a private directory: ${directory}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  let created = false;
  try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  assertPrivateDirectory(directory);
  if (created) fsyncDirectory(path.dirname(directory));
}

export class FormationObjectStore {
  readonly objectsRoot: string;
  readonly stagingRoot: string;

  constructor(readonly hostRoot: string) {
    if (!path.isAbsolute(hostRoot)) throw new FormationObjectStoreError("formation object-store root must be absolute");
    const existed = fs.existsSync(hostRoot);
    fs.mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(hostRoot);
    if (!existed) fsyncDirectory(path.dirname(hostRoot));
    this.objectsRoot = path.join(hostRoot, "objects");
    this.stagingRoot = path.join(hostRoot, "staging");
    ensurePrivateDirectory(this.objectsRoot);
    ensurePrivateDirectory(this.stagingRoot);
  }

  digest(bytes: Buffer | string): { sha256: string; bytes: number } {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    if (value.length > MAX_OBJECT_BYTES) throw new FormationObjectStoreError(`formation object exceeds ${MAX_OBJECT_BYTES} bytes`);
    return { sha256: sha256(value), bytes: value.length };
  }

  objectPath(digestValue: string): string {
    if (!DIGEST_RE.test(digestValue)) throw new FormationObjectStoreError("invalid formation object digest");
    return path.join(this.objectsRoot, digestValue.slice(0, 2), digestValue.slice(2));
  }

  put(bytes: Buffer | string): { sha256: string; bytes: number } {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
    const descriptor = this.digest(value);
    const directory = path.join(this.objectsRoot, descriptor.sha256.slice(0, 2));
    const destination = this.objectPath(descriptor.sha256);
    ensurePrivateDirectory(directory);
    try {
      const existing = this.read(descriptor.sha256);
      if (!existing.equals(value)) throw new FormationObjectStoreError(`formation object digest collision at ${descriptor.sha256}`);
      return descriptor;
    } catch (error) {
      if (!(error instanceof FormationObjectStoreError) || !error.message.startsWith("formation object is missing")) throw error;
    }

    const staging = path.join(this.stagingRoot, `${crypto.randomUUID()}.object`);
    const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(staging, destination);
      fsyncDirectory(directory);
      const linked = this.read(descriptor.sha256);
      if (!linked.equals(value)) throw new FormationObjectStoreError(`formation object digest collision at ${descriptor.sha256}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = this.read(descriptor.sha256);
      if (!existing.equals(value)) throw new FormationObjectStoreError(`formation object digest collision at ${descriptor.sha256}`);
    } finally {
      fs.unlinkSync(staging);
      fsyncDirectory(this.stagingRoot);
    }
    return descriptor;
  }

  has(digestValue: string): boolean {
    try { this.read(digestValue); return true; }
    catch (error) {
      if (error instanceof FormationObjectStoreError && error.message.startsWith("formation object is missing")) return false;
      throw error;
    }
  }

  read(digestValue: string): Buffer {
    const file = this.objectPath(digestValue);
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FormationObjectStoreError(`formation object is missing: ${digestValue}`);
      }
      throw error;
    }
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_OBJECT_BYTES)) throw new FormationObjectStoreError(`formation object is unsafe: ${digestValue}`);
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || sha256(bytes) !== digestValue) {
        throw new FormationObjectStoreError(`formation object changed or failed integrity: ${digestValue}`);
      }
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }

  collectUnreferenced(reachable: ReadonlySet<string>): string[] {
    this.collectAbandonedStaging(Date.now() - ABANDONED_STAGING_AGE_MS);
    const removed: string[] = [];
    for (const prefix of fs.readdirSync(this.objectsRoot)) {
      if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
      const directory = path.join(this.objectsRoot, prefix);
      assertPrivateDirectory(directory);
      for (const suffix of fs.readdirSync(directory)) {
        const digestValue = `${prefix}${suffix}`;
        if (!DIGEST_RE.test(digestValue) || reachable.has(digestValue)) continue;
        const file = path.join(directory, suffix);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        fs.unlinkSync(file);
        removed.push(digestValue);
      }
      fsyncDirectory(directory);
    }
    return removed.sort();
  }

  private collectAbandonedStaging(olderThanMs: number): void {
    for (const name of fs.readdirSync(this.stagingRoot)) {
      if (!/^[0-9a-f-]{36}\.object$/i.test(name)) continue;
      const file = path.join(this.stagingRoot, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs > olderThanMs) continue;
      fs.unlinkSync(file);
    }
    fsyncDirectory(this.stagingRoot);
  }
}
