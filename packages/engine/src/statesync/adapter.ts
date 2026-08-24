import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * t-5786bc — the backup destination, as the smallest interface a "remote disk" honestly is.
 *
 * Four operations, all keyed by forward-slash relative paths. Filesystem implements them directly;
 * an s3-compatible backend maps them 1:1 (putObject/getObject/list/deleteObject); gdrive likewise.
 * Deliberately NOT content-addressed and NOT incremental: the durable set is kilobytes, so every
 * generation is written whole. Optimize when a real workspace makes that slow, not before.
 *
 * ## Toda I/O aqui é ASSÍNCRONA, e isso não é estilo
 *
 * A primeira versão usava `fs.writeFileSync` e companhia DENTRO destes métodos `async` — a assinatura
 * prometia não bloquear e a implementação bloqueava. Numa engine de event loop único isso para tudo:
 * enquanto o backup escreve, a engine não responde a nada, nem à sonda de saúde que o shell usa para
 * decidir se ela está viva.
 *
 * Medido em 2026-08-24 num destino real (disco Windows montado no WSL, 197 arquivos, 22 MB):
 * **2740 ms** só na escrita (13,9 ms por arquivo) e mais 704 ms relendo. O orçamento da sonda é de
 * 750 ms, e o supervisor conclui "zumbi" depois de 10 s mudo — então um backup grande o bastante faz
 * o shell MATAR uma engine perfeitamente viva, e o ciclo se repete a cada passe.
 *
 * O comentário acima dizia "otimize quando um workspace real tornar isso lento". Um workspace real
 * tornou. A correção não é otimizar o volume: é não segurar o loop enquanto se escreve.
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
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // tmp + rename, not link: mounted destinations (SMB/FUSE) routinely lack hardlink support.
    const tmp = `${target}.tmp.${process.pid}`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertSafeKey(prefix);
    const base = path.join(this.root, ...prefix.split("/"));
    const keys: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile() && !entry.name.includes(".tmp.")) keys.push(`${prefix}/${childRel}`);
      }
    };
    await walk(base, "");
    return keys;
  }

  async remove(key: string): Promise<void> {
    try {
      await fsp.unlink(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
