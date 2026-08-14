/**
 * t-cd3626 V1–V2.5 — bounded engine log ring for Control → Engine.
 * Captures console.*; optional file tail survives daemon restart (V2.5).
 */
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

const DEFAULT_CAP = 200;
const DEFAULT_MAX_FILE_BYTES = 1_500_000;

export type LogLevel = "I" | "W" | "E" | "D";

/**
 * Node's own default 'warning' handler prints via console.error (e.g. "(node:1586539)
 * ExperimentalWarning: SQLite is an experimental feature..."), so our console.error
 * capture tags it "E" even though it's not a daemon fault. t-3cdb91: reclassify these
 * to "W" at capture time so the ring's E-level (and hasError()) means an actual error.
 */
const NODE_PROCESS_WARNING_RE = /\(node:\d+\)\s+\S*Warning:/;

export class EngineLogRing {
  private readonly lines: string[] = [];
  private readonly filePath?: string;
  private readonly maxFileBytes: number;

  constructor(
    private readonly cap = DEFAULT_CAP,
    opts?: { filePath?: string; maxFileBytes?: number },
  ) {
    this.filePath = opts?.filePath;
    this.maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (this.filePath) this.hydrateFromFile();
  }

  push(line: string, level: LogLevel = "I"): void {
    const text = String(line).replace(/\r?\n$/, "");
    if (!text) return;
    const stamped = `${new Date().toISOString()} ${level} ${text}`;
    const out = stamped.length > 2000 ? `${stamped.slice(0, 2000)}…` : stamped;
    this.lines.push(out);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
    this.appendFile(out);
  }

  pushArgs(level: LogLevel, args: unknown[]): void {
    try {
      const msg = args
        .map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 2, breakLength: 120 })))
        .join(" ");
      const effectiveLevel = level === "E" && NODE_PROCESS_WARNING_RE.test(msg) ? "W" : level;
      this.push(msg, effectiveLevel);
    } catch {
      /* never break logging */
    }
  }

  tail(): string[] {
    return this.lines.slice();
  }

  /** True if any in-memory line is level E. */
  hasError(): boolean {
    return this.lines.some((l) => {
      const m = l.match(/^\S+\s+([IWED])\s/);
      return m?.[1] === "E";
    });
  }

  clear(): void {
    this.lines.length = 0;
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.filePath, "", { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  private hydrateFromFile(): void {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parts = raw.split(/\r?\n/).filter((l) => l.length > 0);
      const take = parts.slice(-this.cap);
      this.lines.push(...take);
    } catch {
      /* best-effort */
    }
  }

  private appendFile(line: string): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.filePath, `${line}\n`, { mode: 0o600 });
      this.rotateIfNeeded();
    } catch {
      /* best-effort */
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath) return;
    try {
      const st = fs.statSync(this.filePath);
      if (st.size <= this.maxFileBytes) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      const keep = raw.slice(Math.floor(raw.length / 2));
      const nl = keep.indexOf("\n");
      fs.writeFileSync(this.filePath, nl >= 0 ? keep.slice(nl + 1) : keep, { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }
}

let installed: EngineLogRing | undefined;

export function installEngineLogRing(
  capOrOpts: number | { cap?: number; filePath?: string; maxFileBytes?: number } = DEFAULT_CAP,
): EngineLogRing {
  if (installed) return installed;
  const opts = typeof capOrOpts === "number" ? { cap: capOrOpts } : capOrOpts;
  const ring = new EngineLogRing(opts.cap ?? DEFAULT_CAP, {
    filePath: opts.filePath,
    maxFileBytes: opts.maxFileBytes,
  });
  installed = ring;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  console.log = (...args: unknown[]) => {
    ring.pushArgs("I", args);
    orig.log(...args);
  };
  console.info = (...args: unknown[]) => {
    ring.pushArgs("I", args);
    orig.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    ring.pushArgs("W", args);
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    ring.pushArgs("E", args);
    orig.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    ring.pushArgs("D", args);
    orig.debug(...args);
  };
  ring.push(
    opts.filePath ? `engine log ring installed (file ${opts.filePath})` : "engine log ring installed",
    "I",
  );
  return ring;
}

export function getEngineLogRing(): EngineLogRing | undefined {
  return installed;
}

export function _resetEngineLogRingForTests(): void {
  installed = undefined;
}

/** Format control-plane events as log-like lines (V2 source "events"). */
export function formatEventsAsLogLines(
  events: Array<{ at?: string; kind?: string; seq?: number; payload?: Record<string, unknown> }>,
  cap = 80,
): string[] {
  const slice = events.slice(-cap);
  return slice.map((e) => {
    const at = typeof e.at === "string" ? e.at : new Date().toISOString();
    const kind = typeof e.kind === "string" ? e.kind : "event";
    const seq = typeof e.seq === "number" ? e.seq : "?";
    let detail = "";
    try {
      detail = e.payload ? util.inspect(e.payload, { depth: 1, breakLength: 100, compact: true }) : "";
    } catch {
      detail = "";
    }
    if (detail.length > 180) detail = `${detail.slice(0, 180)}…`;
    return `${at} I [event#${seq}] ${kind}${detail ? ` ${detail}` : ""}`;
  });
}
