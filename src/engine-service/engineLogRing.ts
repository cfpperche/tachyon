/**
 * t-cd3626 V1 — bounded in-process engine log ring for Control → Engine.
 * Captures console.* (and optional stderr notes). Not a substitute for journald.
 */
import util from "node:util";

const DEFAULT_CAP = 150;

export class EngineLogRing {
  private readonly lines: string[] = [];
  constructor(private readonly cap = DEFAULT_CAP) {}

  push(line: string, level: "I" | "W" | "E" | "D" = "I"): void {
    const text = String(line).replace(/\r?\n$/, "");
    if (!text) return;
    const stamped = `${new Date().toISOString()} ${level} ${text}`;
    this.lines.push(stamped.length > 2000 ? `${stamped.slice(0, 2000)}…` : stamped);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
  }

  pushArgs(level: "I" | "W" | "E" | "D", args: unknown[]): void {
    try {
      const msg = args
        .map((a) => (typeof a === "string" ? a : util.inspect(a, { depth: 2, breakLength: 120 })))
        .join(" ");
      this.push(msg, level);
    } catch {
      /* never break logging */
    }
  }

  tail(): string[] {
    return this.lines.slice();
  }

  clear(): void {
    this.lines.length = 0;
  }
}

let installed: EngineLogRing | undefined;

/** Idempotent process-wide install. Returns the live ring. */
export function installEngineLogRing(cap = DEFAULT_CAP): EngineLogRing {
  if (installed) return installed;
  const ring = new EngineLogRing(cap);
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
  ring.push("engine log ring installed", "I");
  return ring;
}

export function getEngineLogRing(): EngineLogRing | undefined {
  return installed;
}

/** Test-only: drop singleton so a suite can reinstall. */
export function _resetEngineLogRingForTests(): void {
  installed = undefined;
}
