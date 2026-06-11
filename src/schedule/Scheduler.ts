import { parseEvery, parseAt, type TachyonConfig, type ScheduleDef } from "../config/loadConfig.js";

/**
 * Schedules (F23) — fires actions on a timer, but ONLY while the workspace is
 * open (honest scope: the extension isn't a daemon; same semantics as
 * watch-restart). `every:` is an interval since the last fire / activation;
 * `at:` is a daily wall-clock time (local), fired once per day.
 *
 * Pure and unit-testable: inject now() and an onFire() callback; the extension
 * drives tick() from its existing ticker and routes onFire to the runners.
 */

export interface ScheduleStatus {
  name: string;
  def: ScheduleDef;
  lastRun?: number;
  /** epoch ms of the next expected fire (best effort), undefined if unknown */
  nextRun?: number;
  /** paused this session — won't fire until resumed (session memory, not config) */
  paused: boolean;
}

export interface SchedulerOptions {
  getConfig: () => TachyonConfig | undefined;
  now?: () => number;
  onFire: (name: string, def: ScheduleDef) => Promise<void> | void;
  onError?: (name: string, err: unknown) => void;
}

const DAY_MS = 86_400_000;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export class Scheduler {
  private base = new Map<string, number>(); // every: anchor (last fire or activation)
  private lastRun = new Map<string, number>();
  private firedDay = new Map<string, string>(); // at: dayKey it last fired
  private paused = new Set<string>(); // session-paused names (not persisted)
  private started = false;
  private readonly now: () => number;

  /** Pause/resume a schedule for this session (memory only — config is untouched). */
  setPaused(name: string, paused: boolean): void {
    if (paused) this.paused.add(name);
    else this.paused.delete(name);
  }
  isPaused(name: string): boolean {
    return this.paused.has(name);
  }

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now;
  }

  private targetToday(at: string, now: number): number {
    const { h, m } = parseAt(at)!;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  /** Workspace activated: anchor every-schedules; catch-up at-schedules opted in. */
  activate(): void {
    const now = this.now();
    this.started = true;
    for (const [name, def] of Object.entries(this.opts.getConfig()?.schedules ?? {})) {
      if (def.every) {
        if (!this.base.has(name)) this.base.set(name, now);
      } else if (def.at) {
        const passed = now >= this.targetToday(def.at, now);
        if (passed && this.firedDay.get(name) !== dayKey(now)) {
          // Already past today's time at startup. catchUp -> fire once now;
          // otherwise treat today as already handled (missed times don't fire —
          // an at-schedule only fires when the clock CROSSES it while open).
          if (def.catchUp) this.fire(name, def, now);
          else this.firedDay.set(name, dayKey(now));
        }
      }
    }
  }

  /** Fires anything due. No-op until activate(). Idempotent per due-window. */
  tick(): void {
    if (!this.started) return;
    const now = this.now();
    const scheds = this.opts.getConfig()?.schedules ?? {};
    // forget state for schedules removed from config
    for (const n of [...this.base.keys()]) if (!(n in scheds)) this.base.delete(n);
    for (const [name, def] of Object.entries(scheds)) {
      if (def.every) {
        const interval = parseEvery(def.every);
        if (interval === null) continue;
        if (!this.base.has(name)) {
          this.base.set(name, now); // first sighting: anchor, don't fire immediately
          continue;
        }
        if (now - (this.base.get(name) as number) >= interval) this.fire(name, def, now);
      } else if (def.at) {
        if (now >= this.targetToday(def.at, now) && this.firedDay.get(name) !== dayKey(now)) {
          this.fire(name, def, now);
        }
      }
    }
  }

  private fire(name: string, def: ScheduleDef, now: number): void {
    if (this.paused.has(name)) return; // paused this session — stays due, fires on resume
    this.lastRun.set(name, now);
    if (def.every) this.base.set(name, now);
    if (def.at) this.firedDay.set(name, dayKey(now));
    try {
      const r = this.opts.onFire(name, def);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e) => this.opts.onError?.(name, e));
      }
    } catch (e) {
      this.opts.onError?.(name, e);
    }
  }

  nextRun(name: string): number | undefined {
    const now = this.now();
    const def = this.opts.getConfig()?.schedules?.[name];
    if (!def) return undefined;
    if (def.every) {
      const interval = parseEvery(def.every);
      if (interval === null) return undefined;
      return (this.base.get(name) ?? now) + interval;
    }
    if (def.at) {
      const t = this.targetToday(def.at, now);
      return this.firedDay.get(name) === dayKey(now) || now >= t ? t + DAY_MS : t;
    }
    return undefined;
  }

  list(): ScheduleStatus[] {
    const scheds = this.opts.getConfig()?.schedules ?? {};
    return Object.entries(scheds)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, def]) => ({ name, def, lastRun: this.lastRun.get(name), nextRun: this.nextRun(name), paused: this.paused.has(name) }));
  }
}
