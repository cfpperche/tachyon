import fs from "node:fs";
import path from "node:path";
import type { HostDisposable, WatchEvents } from "../workspace/EngineHost.js";

const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_NATIVE_DEBOUNCE_MS = 25;
const DEFAULT_MAX_ENTRIES = 50_000;
const MAX_BRACE_EXPANSIONS = 64;

export interface PollingFileWatcherOptions {
  intervalMs?: number;
  nativeDebounceMs?: number;
  maxEntries?: number;
  onError?: (error: Error) => void;
}

/** A Node-only watcher: fs.watch provides low-latency hints, while bounded snapshots are authoritative. */
export class PollingFileWatcher implements HostDisposable {
  private previous: Map<string, string>;
  private readonly timer: NodeJS.Timeout;
  private native: fs.FSWatcher | undefined;
  private nativePollTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private lastError: string | undefined;

  constructor(
    private readonly root: string,
    private readonly glob: string,
    private readonly events: WatchEvents,
    private readonly onEvent: () => void,
    private readonly options: PollingFileWatcherOptions = {},
  ) {
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const nativeDebounceMs = options.nativeDebounceMs ?? DEFAULT_NATIVE_DEBOUNCE_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("watch interval must be a positive integer");
    if (!Number.isSafeInteger(nativeDebounceMs) || nativeDebounceMs < 0) throw new Error("watch debounce must be a non-negative integer");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("watch maxEntries must be a positive integer");
    this.plan = watcherPlan(root, glob, maxEntries);
    this.previous = this.scan();
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref?.();
    try {
      this.native = fs.watch(this.plan.hintRoot, { persistent: false }, () => this.scheduleNativePoll());
      this.native.on("error", (error) => {
        this.native?.close();
        this.native = undefined;
        this.report(error);
      });
    } catch {
      // The directory may not exist yet. Polling remains authoritative and observes its creation.
    }
  }

  private readonly plan: WatcherPlan;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    if (this.nativePollTimer) clearTimeout(this.nativePollTimer);
    this.nativePollTimer = undefined;
    this.native?.close();
    this.native = undefined;
  }

  private scheduleNativePoll(): void {
    if (this.disposed) return;
    if (this.nativePollTimer) clearTimeout(this.nativePollTimer);
    this.nativePollTimer = setTimeout(() => {
      this.nativePollTimer = undefined;
      this.poll();
    }, this.options.nativeDebounceMs ?? DEFAULT_NATIVE_DEBOUNCE_MS);
    this.nativePollTimer.unref?.();
  }

  private poll(): void {
    if (this.disposed) return;
    try {
      const current = this.scan();
      const created = hasCreated(this.previous, current);
      const deleted = hasCreated(current, this.previous);
      const changed = hasChanged(this.previous, current);
      this.previous = current;
      this.lastError = undefined;
      if ((created && this.events.create) || (deleted && this.events.delete) || (changed && this.events.change)) {
        this.onEvent();
      }
    } catch (error) {
      this.report(error);
    }
  }

  private scan(): Map<string, string> {
    const output = new Map<string, string>();
    let visited = 0;
    const visit = (absolute: string, relative: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(absolute, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        visited++;
        if (visited > this.plan.maxEntries) throw new Error(`watch '${this.glob}' exceeded ${this.plan.maxEntries} filesystem entries`);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childAbsolute = path.join(absolute, entry.name);
        if (this.plan.matches(childRelative)) {
          try {
            const stat = fs.lstatSync(childAbsolute);
            output.set(childRelative, `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if (entry.isDirectory() && !entry.isSymbolicLink() && depth < this.plan.maxDepth) {
          visit(childAbsolute, childRelative, depth + 1);
        }
      }
    };

    if (this.plan.exactRelative) {
      const absolute = path.join(this.root, ...this.plan.exactRelative.split("/"));
      try {
        const stat = fs.lstatSync(absolute);
        output.set(this.plan.exactRelative, `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return output;
    }

    visit(this.plan.scanRoot, this.plan.baseRelative, 1);
    return output;
  }

  private report(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (normalized.message === this.lastError) return;
    this.lastError = normalized.message;
    this.options.onError?.(normalized);
  }
}

interface WatcherPlan {
  exactRelative?: string;
  baseRelative: string;
  scanRoot: string;
  hintRoot: string;
  maxDepth: number;
  maxEntries: number;
  matches(relative: string): boolean;
}

function watcherPlan(root: string, input: string, maxEntries: number): WatcherPlan {
  const canonicalRoot = fs.realpathSync(root);
  const glob = normalizeGlob(input);
  const magicIndex = glob.split("/").findIndex((segment) => /[*?{[]/.test(segment));
  if (magicIndex < 0) {
    const absolute = path.resolve(canonicalRoot, ...glob.split("/"));
    assertUnderRoot(absolute, canonicalRoot);
    return {
      exactRelative: glob,
      baseRelative: path.posix.dirname(glob) === "." ? "" : path.posix.dirname(glob),
      scanRoot: path.dirname(absolute),
      hintRoot: path.dirname(absolute),
      maxDepth: 0,
      maxEntries,
      matches: (relative) => relative === glob,
    };
  }
  const segments = glob.split("/");
  const baseRelative = segments.slice(0, magicIndex).join("/");
  const scanRoot = path.resolve(canonicalRoot, ...segments.slice(0, magicIndex));
  assertUnderRoot(scanRoot, canonicalRoot);
  const expanded = expandBraces(glob);
  const regexes = expanded.map(globRegex);
  const maxDepth = expanded.some((candidate) => candidate.includes("**"))
    ? Number.POSITIVE_INFINITY
    : Math.max(...expanded.map((candidate) => candidate.split("/").length - magicIndex));
  return {
    baseRelative,
    scanRoot,
    hintRoot: scanRoot,
    maxDepth,
    maxEntries,
    matches: (relative) => regexes.some((regex) => regex.test(relative)),
  };
}

function normalizeGlob(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 1_024 || input.includes("\0") || path.isAbsolute(input)) {
    throw new Error("watch glob must be a bounded relative path");
  }
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.split("/").some((segment) => segment === ".." || segment.length === 0)) {
    throw new Error("watch glob cannot escape the workspace");
  }
  if (normalized.startsWith("!") || /[?*+@!]\(/.test(normalized)) {
    throw new Error("watch glob uses unsupported negation or extglob syntax");
  }
  return normalized;
}

function expandBraces(input: string): string[] {
  const open = input.indexOf("{");
  if (open < 0) return [input];
  const close = input.indexOf("}", open + 1);
  if (close < 0) throw new Error("watch glob has an unmatched brace");
  const choices = input.slice(open + 1, close).split(",");
  if (choices.length < 2 || choices.some((choice) => choice.length === 0)) throw new Error("watch glob has an invalid brace group");
  const expanded = choices.flatMap((choice) => expandBraces(`${input.slice(0, open)}${choice}${input.slice(close + 1)}`));
  if (expanded.length > MAX_BRACE_EXPANSIONS) throw new Error("watch glob expands to too many alternatives");
  return expanded;
}

function globRegex(glob: string): RegExp {
  let output = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        while (glob[i + 1] === "*") i++;
        if (glob[i + 1] === "/") { i++; output += "(?:.*/)?"; }
        else output += ".*";
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) throw new Error("watch glob has an unmatched character class");
      const raw = glob.slice(i + 1, close);
      if (!raw) throw new Error("watch glob has an empty character class");
      const negated = raw.startsWith("!") ? `^${escapeClass(raw.slice(1))}` : escapeClass(raw);
      output += `[${negated}]`;
      i = close;
    } else output += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${output}$`);
}

function escapeClass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function assertUnderRoot(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("watch path escapes the workspace");
}

function hasCreated(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const key of after.keys()) if (!before.has(key)) return true;
  return false;
}

function hasChanged(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const [key, value] of after) if (before.get(key) !== undefined && before.get(key) !== value) return true;
  return false;
}
