/**
 * Spec 257 (D9, OQ2) — the per-run probe artifact store. Artifacts live under `.tachyon/probes/<runId>/`
 * (gitignored, machine-local, off the public surface). Provides: a scratch dir the runner points the
 * runtime's artifact files at; atomic (temp+rename) publication of the result envelope + metadata;
 * a per-artifact size cap with a truncation flag (a runaway `--json` event stream can't fill disk);
 * bounded retention (prune by age AND count, oldest first); and strict path containment — a `runId`
 * is validated as a single safe segment so an artifact can never escape the probe root.
 *
 * No secret redaction in v1 (ratified): artifacts are sensitive-by-default and gitignored; the MCP
 * payload-size discipline (summary inline, full text by path) lives at the Bridge boundary (D9).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProbeEnvelope } from "./taxonomy.js";

/** Recorded with every run (D5 versioning surface) so a CLI/adapter upgrade is visible after the fact. */
export interface ProbeRunMeta {
  runId: string;
  runtime: string;
  adapterVersion: string;
  binaryVersion?: string;
  archetype?: string;
  createdAt: string; // ISO
  finishedAt?: string; // ISO
}

export interface ProbeStoreOptions {
  /** keep at most this many runs (oldest pruned). */
  maxRuns?: number;
  /** prune runs older than this. */
  maxAgeMs?: number;
  /** truncate any single artifact past this many bytes (flagged). */
  maxArtifactBytes?: number;
}

const DEFAULTS: Required<ProbeStoreOptions> = {
  maxRuns: 200,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxArtifactBytes: 5 * 1024 * 1024, // 5 MiB
};

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** A fresh, path-safe run id. */
export function mintRunId(): string {
  return `probe-${crypto.randomUUID()}`;
}

export class ProbeStore {
  private readonly opts: Required<ProbeStoreOptions>;

  constructor(
    private readonly root: string,
    opts: ProbeStoreOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** The per-run directory, with strict containment — throws on a `runId` that isn't a safe segment. */
  dirFor(runId: string): string {
    if (!SAFE_SEGMENT.test(runId)) throw new Error(`unsafe probe runId: ${JSON.stringify(runId)}`);
    return path.join(this.root, runId);
  }

  /** Where the runner tells the runtime to write its artifact files for this run. */
  async scratchDir(runId: string): Promise<string> {
    const dir = this.dirFor(runId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Write text into an artifact, capped at `maxArtifactBytes` (truncation flagged). Atomic. */
  async writeArtifact(runId: string, name: string, content: string): Promise<{ path: string; truncated: boolean }> {
    if (!SAFE_SEGMENT.test(name.replace(/\.[A-Za-z0-9]+$/, ""))) throw new Error(`unsafe artifact name: ${JSON.stringify(name)}`);
    const dir = this.dirFor(runId);
    await fs.mkdir(dir, { recursive: true });
    const buf = Buffer.from(content, "utf8");
    const truncated = buf.byteLength > this.opts.maxArtifactBytes;
    const out = truncated ? buf.subarray(0, this.opts.maxArtifactBytes).toString("utf8") + "\n…[truncated]" : content;
    const target = path.join(dir, name);
    await this.atomicWrite(target, out);
    return { path: target, truncated };
  }

  /** Write metadata at launch (so {@link listIncomplete}/reap can see an in-flight run). Atomic. */
  async writeMeta(meta: ProbeRunMeta): Promise<void> {
    const dir = this.dirFor(meta.runId);
    await fs.mkdir(dir, { recursive: true });
    await this.atomicWrite(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
  }

  /** Runs that have metadata but no result — incomplete (their process is gone after a restart). */
  async listIncomplete(): Promise<ProbeRunMeta[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const out: ProbeRunMeta[] = [];
    for (const name of names) {
      if (!SAFE_SEGMENT.test(name)) continue;
      const dir = path.join(this.root, name);
      try {
        const metaRaw = await fs.readFile(path.join(dir, "metadata.json"), "utf8");
        try {
          await fs.access(path.join(dir, "result.json"));
          continue; // has a result → complete
        } catch {
          out.push(JSON.parse(metaRaw) as ProbeRunMeta); // no result → incomplete
        }
      } catch {
        /* no metadata → not a probe run we own */
      }
    }
    return out;
  }

  /** Publish the result envelope + metadata atomically. */
  async writeResult(envelope: ProbeEnvelope, meta: ProbeRunMeta): Promise<void> {
    const dir = this.dirFor(meta.runId);
    await fs.mkdir(dir, { recursive: true });
    await this.atomicWrite(path.join(dir, "result.json"), JSON.stringify(envelope, null, 2));
    await this.atomicWrite(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
  }

  /** Read back a finished run, or null if absent/unreadable. */
  async readResult(runId: string): Promise<{ envelope: ProbeEnvelope; meta: ProbeRunMeta } | null> {
    const dir = this.dirFor(runId);
    try {
      const [env, meta] = await Promise.all([
        fs.readFile(path.join(dir, "result.json"), "utf8"),
        fs.readFile(path.join(dir, "metadata.json"), "utf8"),
      ]);
      return { envelope: JSON.parse(env) as ProbeEnvelope, meta: JSON.parse(meta) as ProbeRunMeta };
    } catch {
      return null;
    }
  }

  /** Bounded retention (OQ2): remove runs older than maxAgeMs OR beyond the newest maxRuns. */
  async prune(now = Date.now()): Promise<{ removed: string[] }> {
    let entries: { runId: string; mtimeMs: number }[];
    try {
      const names = await fs.readdir(this.root);
      entries = [];
      for (const name of names) {
        if (!SAFE_SEGMENT.test(name)) continue;
        try {
          const st = await fs.stat(path.join(this.root, name));
          if (st.isDirectory()) entries.push({ runId: name, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished mid-scan */
        }
      }
    } catch {
      return { removed: [] }; // no store yet
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    const removed: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const tooOld = now - e.mtimeMs > this.opts.maxAgeMs;
      const overCount = i >= this.opts.maxRuns;
      if (tooOld || overCount) {
        await fs.rm(path.join(this.root, e.runId), { recursive: true, force: true });
        removed.push(e.runId);
      }
    }
    return { removed };
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const tmp = `${target}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, target);
  }
}
