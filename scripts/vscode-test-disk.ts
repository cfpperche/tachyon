/**
 * t-3374e2 (SDD 398 D5) — `npm run disk:vscode-test`: the one door to the editor-host cache.
 *
 *   npm run disk:vscode-test                      inventory every checkout (read-only)
 *   npm run disk:vscode-test -- plan              inventory + what a reclaim would do (read-only)
 *   npm run disk:vscode-test -- reclaim           the same plan, still a dry run
 *   npm run disk:vscode-test -- reclaim --confirm execute it
 *   flags: --keep <n> (default 1)  --store <path>
 *
 * A HUMAN TYPES THIS. Nothing in the product calls it: no activation hook, no boot path, no timer, no
 * Bridge tool. The owner's decision was "no GC mechanism for now", and the shape that honours it is a
 * command that has to be typed, reports by default, and refuses to delete without `--confirm` on the
 * same line. `scripts/vscode-test-cache.ts` owns the decision; this file owns the measuring and the
 * doing, so every refusal is unit-tested without a filesystem.
 *
 * WHY ALL CHECKOUTS AND NOT THIS ONE. `@vscode/test-electron` hardcodes `<cwd>/.vscode-test`, so the
 * duplication is BETWEEN checkouts and invisible from inside any one of them. The checkout list comes
 * from `git worktree list` — git's own answer about what exists, which is also the registry's
 * canonical pair (D1). Nothing is discovered by scanning directories, so a folder that merely looks
 * like a checkout is never touched.
 *
 * WHAT THE NUMBERS MEAN. Sizes are ALLOCATED bytes (`du -s --block-size=1`), not apparent size,
 * because allocated blocks are what come back to ext4. They come back INSIDE WSL; the Windows VHDX
 * does not shrink. See docs/runbooks/disk-and-vhdx.md — every total this prints says so on the line.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMPLETE_MARKER,
  DEFAULT_STORE_SUBPATH,
  DOWNLOAD_DIR_NAME,
  VSCODE_TEST_DIR,
  applyReclaimPlan,
  planVscodeTestReclaim,
  renderInventory,
  renderReclaimPlan,
  wslBytes,
  type CacheEntry,
  type CacheInventory,
  type CheckoutCache,
  type ReclaimIo,
  type StoreEntry,
} from "./vscode-test-cache.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A process we are allowed to look at. Fields are absent when /proc refused them. */
interface LiveProcess {
  pid: number;
  exe?: string;
  cwd?: string;
  cmd: string;
}

/** The editor-host harness, as it appears on a command line. Deliberately not a loose "vscode-test". */
const HARNESS_CMD = /(^|[\s/])vscode-test(\s|$)|@vscode\/test-cli|extensionTestsPath/;

function probeProcesses(): { state: "measured" | "unavailable"; processes: LiveProcess[] } {
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return { state: "unavailable", processes: [] };
  }
  if (pids.length === 0) return { state: "unavailable", processes: [] };

  const processes: LiveProcess[] = [];
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue; // this very command; its cmdline mentions the cache
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      continue; // gone between readdir and read, or not ours to read
    }
    const link = (what: string): string | undefined => {
      try {
        return fs.readlinkSync(`/proc/${pid}/${what}`);
      } catch {
        return undefined; // another user's process, or a kernel thread
      }
    };
    processes.push({ pid: Number(pid), exe: link("exe"), cwd: link("cwd"), cmd });
  }
  return { state: "measured", processes };
}

const under = (p: string | undefined, dir: string): boolean => p !== undefined && (p === dir || p.startsWith(`${dir}/`));

/** Every live process holding a payload, named by pid and by HOW it holds it — a reason a human can check. */
function refsTo(processes: LiveProcess[], payloadPaths: string[]): string[] {
  const refs: string[] = [];
  for (const proc of processes) {
    for (const payload of payloadPaths) {
      if (under(proc.exe, payload)) refs.push(`pid ${proc.pid} exe ${proc.exe}`);
      else if (under(proc.cwd, payload)) refs.push(`pid ${proc.pid} cwd ${proc.cwd}`);
      else if (proc.cmd.includes(payload)) refs.push(`pid ${proc.pid} cmdline ${proc.cmd.slice(0, 120)}`);
      else continue;
      break;
    }
  }
  return refs;
}

/** Allocated bytes, which is what returns to ext4. Absent/unreadable reads as 0 and is stated as such. */
function allocatedBytes(p: string): number {
  try {
    const out = execFileSync("du", ["-s", "--block-size=1", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number.parseInt(out.split("\t")[0] ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

function deviceOf(p: string): number | undefined {
  let at = path.resolve(p);
  for (;;) {
    try {
      return fs.statSync(at).dev;
    } catch {
      const up = path.dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
}

function listCheckouts(): string[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

function readCheckout(checkoutPath: string, storePath: string, live: LiveProcess[]): CheckoutCache {
  const cachePath = path.join(checkoutPath, VSCODE_TEST_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(cachePath);
  } catch {
    return { path: checkoutPath, cachePath, cacheExists: false, entries: [], stateBytes: 0, harnessActive: false };
  }

  const entries: CacheEntry[] = [];
  let stateBytes = 0;
  for (const name of names.sort()) {
    const at = path.join(cachePath, name);
    const match = DOWNLOAD_DIR_NAME.exec(name);
    if (!match?.groups) {
      // `user-data`, `extensions`, and anything else the harness leaves: per-checkout state. Measured
      // so the report is honest about the whole directory, never a candidate for pooling or deletion.
      stateBytes += allocatedBytes(at);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      continue; // vanished mid-scan
    }

    if (stat.isSymbolicLink()) {
      const target = path.resolve(cachePath, fs.readlinkSync(at));
      const shape = under(target, storePath) ? "store-link" : "other-link";
      entries.push({
        name,
        platform: match.groups.platform ?? "",
        version: match.groups.version ?? "",
        bytes: 0, // the payload is not this checkout's; the store row carries its size
        shape,
        complete: fs.existsSync(path.join(at, COMPLETE_MARKER)),
        liveRefs: refsTo(live, [at, target]),
      });
      continue;
    }
    if (!stat.isDirectory()) continue;

    entries.push({
      name,
      platform: match.groups.platform ?? "",
      version: match.groups.version ?? "",
      bytes: allocatedBytes(at),
      shape: "dir",
      complete: fs.existsSync(path.join(at, COMPLETE_MARKER)),
      liveRefs: refsTo(live, [at]),
    });
  }

  const harnessActive = live.some((p) => under(p.cwd, checkoutPath) && HARNESS_CMD.test(p.cmd));
  return { path: checkoutPath, cachePath, cacheExists: true, entries, stateBytes, harnessActive };
}

function readStore(storePath: string, live: LiveProcess[]): StoreEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(storePath);
  } catch {
    return [];
  }
  const entries: StoreEntry[] = [];
  for (const name of names.sort()) {
    const match = DOWNLOAD_DIR_NAME.exec(name);
    if (!match?.groups) continue;
    const at = path.join(storePath, name);
    if (!fs.statSync(at).isDirectory()) continue;
    entries.push({
      name,
      platform: match.groups.platform ?? "",
      version: match.groups.version ?? "",
      bytes: allocatedBytes(at),
      liveRefs: refsTo(live, [at]),
    });
  }
  return entries;
}

/**
 * The applier's filesystem, with a containment guard the pure planner cannot enforce.
 *
 * Every destructive call re-checks that its target is inside the shared store or inside a
 * `<checkout>/.vscode-test`, and `unlink` re-checks that the thing it is about to remove really is a
 * symlink. A planner bug should cost an exception, not somebody's worktree.
 */
function reclaimIo(allowed: string[]): ReclaimIo {
  const assertContained = (p: string): void => {
    const resolved = path.resolve(p);
    if (!allowed.some((dir) => under(resolved, dir))) {
      throw new Error(`refusing to touch ${resolved}: outside the shared store and every checkout's ${VSCODE_TEST_DIR}`);
    }
  };
  return {
    mkdirp: (p) => {
      assertContained(p);
      fs.mkdirSync(p, { recursive: true });
    },
    rename: (from, to) => {
      assertContained(from);
      assertContained(to);
      fs.renameSync(from, to);
    },
    symlink: (target, link) => {
      assertContained(link);
      fs.symlinkSync(target, link, "dir");
    },
    unlink: (p) => {
      assertContained(p);
      if (!fs.lstatSync(p).isSymbolicLink()) throw new Error(`refusing to unlink ${p}: it is not a symlink`);
      fs.unlinkSync(p);
    },
    rmrf: (p) => {
      assertContained(p);
      fs.rmSync(p, { recursive: true, force: true });
    },
  };
}

interface Args {
  command: "inventory" | "plan" | "reclaim";
  confirm: boolean;
  keep: number;
  store: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "inventory",
    confirm: false,
    keep: 1,
    store: process.env.TACHYON_VSCODE_TEST_STORE?.trim() || path.join(os.homedir(), DEFAULT_STORE_SUBPATH),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // npm eats the first one; a human who types a second means nothing by it
    if (a === "inventory" || a === "plan" || a === "reclaim") args.command = a;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--keep") {
      const next = argv[++i];
      if (!next) throw new Error("--keep requires a number");
      args.keep = Number.parseInt(next, 10);
      if (!Number.isFinite(args.keep) || args.keep < 1) throw new Error(`--keep must be >= 1, got ${next}`);
    } else if (a === "--store") {
      const next = argv[++i];
      if (!next) throw new Error("--store requires a path");
      args.store = path.resolve(next);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const HELP = `npm run disk:vscode-test -- [inventory|plan|reclaim] [--confirm] [--keep <n>] [--store <path>]

  inventory  (default)  measure .vscode-test in every checkout of this repo. Read-only.
  plan                  inventory plus what a reclaim would do. Read-only.
  reclaim               the plan, executed ONLY with --confirm. Without it, a dry run.

  --keep <n>   pooled versions to keep, newest first (default 1)
  --store <p>  shared payload store (default ~/${DEFAULT_STORE_SUBPATH}, or TACHYON_VSCODE_TEST_STORE)

Bytes are freed INSIDE WSL. The Windows VHDX does not shrink — see docs/runbooks/disk-and-vhdx.md.
`;

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const probe = probeProcesses();
  const checkouts = listCheckouts().map((c) => readCheckout(c, args.store, probe.processes));
  const storeDevice = deviceOf(args.store);
  const inventory: CacheInventory = {
    checkouts,
    store: {
      path: args.store,
      entries: readStore(args.store, probe.processes),
      sameDevice: checkouts.every((c) => !c.cacheExists || deviceOf(c.cachePath) === storeDevice),
    },
    liveProbe: probe.state,
  };

  const out: string[] = [renderInventory(inventory)];
  if (probe.state === "measured") {
    out.push(`(live-process probe read ${probe.processes.length} processes; processes owned by other users are invisible to it)`);
  }

  if (args.command === "inventory") {
    out.push("", `Next: npm run disk:vscode-test -- plan   (still read-only)`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }

  const plan = planVscodeTestReclaim(inventory, { keep: args.keep });
  out.push("", renderReclaimPlan(plan, { confirm: args.command === "reclaim" && args.confirm }));

  if (args.command !== "reclaim" || !args.confirm) {
    if (plan.actions.length > 0) out.push("", `To execute: npm run disk:vscode-test -- reclaim --keep ${args.keep} --confirm`);
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  }

  const allowed = [args.store, ...checkouts.filter((c) => c.cacheExists).map((c) => c.cachePath)];
  const result = applyReclaimPlan(plan, { confirm: true, io: reclaimIo(allowed) });
  out.push("", `Applied ${result.applied.length} of ${plan.actions.length} action(s); freed ${wslBytes(result.freedBytes)}.`);
  for (const error of result.errors) out.push(`  FAILED: ${error}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return result.errors.length > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
