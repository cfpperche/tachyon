import fs from "node:fs";
import path from "node:path";

/**
 * t-5786bc — the backup destination, as the smallest interface a "remote disk" honestly is.
 *
 * Four operations, all keyed by forward-slash relative paths. Filesystem implements them directly;
 * an s3-compatible backend maps them 1:1 (putObject/getObject/list/deleteObject); gdrive likewise.
 * Deliberately NOT content-addressed and NOT incremental: the durable set is kilobytes, so every
 * generation is written whole. Optimize when a real workspace makes that slow, not before.
 */
export interface StateBackupAdapter {
  /** human-readable destination for logs/errors (a path, a bucket, ...). */
  readonly description: string;
  put(key: string, bytes: Buffer): Promise<void>;
  /** null when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** all keys under the prefix (recursive), in no guaranteed order. */
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

function assertSafeKey(key: string): void {
  if (key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe backup key: ${key}`);
  }
}

/** Backend #1: any locally-mounted path (NAS, SMB, external disk, second drive). */
export class FilesystemBackupAdapter implements StateBackupAdapter {
  readonly description: string;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.description = this.root;
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.resolve(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // tmp + rename, not link: mounted destinations (SMB/FUSE) routinely lack hardlink support.
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertSafeKey(prefix);
    const base = path.join(this.root, ...prefix.split("/"));
    const keys: string[] = [];
    const walk = (dir: string, rel: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile() && !entry.name.includes(".tmp.")) keys.push(`${prefix}/${childRel}`);
      }
    };
    walk(base, "");
    return keys;
  }

  async remove(key: string): Promise<void> {
    try {
      fs.unlinkSync(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
