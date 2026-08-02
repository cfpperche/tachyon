/**
 * t-3374e2 (SDD 398 D5) — pooling and reclaiming the editor-host download, decided purely.
 *
 * WHAT THE MEASUREMENT SAYS. `@vscode/test-electron` resolves its cache as
 * `path.resolve(process.cwd(), ".vscode-test")` and `@vscode/test-cli` never overrides it, so EVERY
 * checkout that runs `npm run test:integration` downloads its own ~1 GiB copy of VS Code. Measured on
 * this host 2026-08-02: 959,107,072 allocated bytes for `vscode-linux-x64-1.128.0` in the primary
 * checkout and 1,054,625,792 for `vscode-linux-x64-1.131.0` in a live agent worktree. Since
 * `shareDependencies` landed (f75b982f) a fresh worktree costs ~34 MiB, which makes this download the
 * largest measured consumer on the box.
 *
 * WHY "KEEP N VERSIONS" WAS THE WRONG SHAPE. The plan's original D5 kept N versions inside ONE
 * workspace's `.vscode-test`. The two copies above are in DIFFERENT checkouts and are DIFFERENT
 * versions, so a per-checkout rule sees one copy each, calls both required, and frees nothing. The
 * unit of the problem is the fleet, not the checkout.
 *
 * SO: POOL FIRST, DELETE LAST. Same argument as `src/worktree/dependencySharing.ts` — all checkouts of
 * one workspace are checkouts of the same repo, so a payload one of them downloaded is byte-for-byte
 * the payload the next one would download. Move each version ONCE into a shared store and leave a
 * symlink where it was; `fallbackToLocalEntries` in test-electron `readdir`s the cache directory and
 * picks the highest matching name, and a symlink answers a readdir exactly like a directory does, so
 * offline resolution is unchanged. Only after pooling is a DELETE even discussable, and then it is one
 * decision for the whole fleet instead of N.
 *
 * WHAT IS NEVER TOUCHED, and why each rule is here rather than "obvious":
 *   · a payload a live process holds — the running editor host's own binary is `<payload>/code`;
 *   · a directory without the `is-complete` marker — that marker is written by test-electron only
 *     after a successful unzip, so its absence means a download is in flight or died mid-way, and
 *     either way the bytes are not ours to reason about;
 *   · every payload in a checkout whose harness is RUNNING — the narrow per-payload probe can race a
 *     suite that is about to resolve a path, so an active harness quarantines its whole checkout;
 *   · a symlink Tachyon did not create — same refusal as `dependencySharing`'s `foreign`;
 *   · anything at all when the live-process probe could not run. Unmeasurable reads as occupied.
 *
 * THIS IS NOT A SECOND WORKTREE AUTHORITY. It classifies CACHE PAYLOADS, never worktrees: it never
 * decides whether a checkout may be removed, and it holds no opinion about dirty/contained/orphan —
 * `worktree_hygiene` owns that and D2 of the investigation is explicit that a second classifier would
 * diverge between report and removal. The only checkout-level fact read here is "is a harness running
 * in it", which is a liveness probe, not an authority.
 *
 * NOTHING HERE RUNS ITSELF. There is no boot hook, no timer and no product caller — the owner refused
 * automatic GC ("no GC mechanism for now"). The only entry point is `scripts/vscode-test-disk.ts`,
 * typed by a human, and `applyReclaimPlan` refuses without an explicit `confirm`.
 */

/** Where the pooled payloads live, relative to the home directory. Sibling of the worktrees base. */
export const DEFAULT_STORE_SUBPATH = ".cache/tachyon/vscode-test";
/** The per-checkout cache directory `@vscode/test-electron` hardcodes as `<cwd>/.vscode-test`. */
export const VSCODE_TEST_DIR = ".vscode-test";
/** Mirrors `downloadDirNameFormat` in @vscode/test-electron — the only names this tool will act on. */
export const DOWNLOAD_DIR_NAME = /^vscode-(?<platform>[a-z0-9-]+)-(?<version>[0-9.]+)$/;
/** Written by test-electron only after a successful unzip; its absence means "download in flight". */
export const COMPLETE_MARKER = "is-complete";
/** The D7 runbook every byte figure points at. Asserted to exist by the unit test, so it cannot rot. */
export const RECLAIM_RUNBOOK = "docs/runbooks/disk-and-vhdx.md";

/** One version payload inside one checkout's `.vscode-test`. */
export interface CacheEntry {
  /** directory name, e.g. `vscode-linux-x64-1.128.0`. */
  name: string;
  platform: string;
  version: string;
  /** ALLOCATED bytes (`du` blocks), not apparent size — allocated is what returns to ext4. 0 for a link. */
  bytes: number;
  /** `dir` = a real directory this checkout owns; `store-link` = our symlink into the store; `other-link` = a link we did not make. */
  shape: "dir" | "store-link" | "other-link";
  /** the `is-complete` marker is present. */
  complete: boolean;
  /** one line per live process holding this payload — shown to the human, so it says WHICH pid. */
  liveRefs: string[];
}

export interface CheckoutCache {
  path: string;
  /** `<path>/.vscode-test`. */
  cachePath: string;
  /** false when this checkout has never run the editor-host harness. */
  cacheExists: boolean;
  entries: CacheEntry[];
  /** bytes held by `user-data`/`extensions` — per-checkout state, never a reclaim candidate. */
  stateBytes: number;
  /** a live harness process is running here; the whole checkout is quarantined. */
  harnessActive: boolean;
}

export interface StoreEntry {
  name: string;
  platform: string;
  version: string;
  bytes: number;
  /**
   * Live processes holding the POOLED payload. Once a version is shared, this — not the per-checkout
   * `liveRefs` — is where a running editor host shows up, because `/proc/<pid>/exe` resolves the
   * symlink and reports the store path. Retiring past it would pull the binary out from under a run.
   */
  liveRefs: string[];
}

export interface SharedStore {
  path: string;
  entries: StoreEntry[];
  /** the store and the checkouts are on one filesystem, so pooling is a rename and not a copy. */
  sameDevice: boolean;
}

export interface CacheInventory {
  checkouts: CheckoutCache[];
  store: SharedStore;
  /** `unavailable` (no /proc, or it could not be read) makes every payload retain. Fail-closed. */
  liveProbe: "measured" | "unavailable";
}

export type ReclaimActionKind =
  /** move a payload into the store and leave a symlink where it was. Frees nothing; enables everything. */
  | "adopt"
  /** the store already holds this exact version: drop this checkout's duplicate copy, link instead. */
  | "dedupe"
  /** point a checkout at a pooled version it does not reach, so a retire cannot strand it. */
  | "link"
  /** delete a pooled payload no checkout needs, and the links that pointed at it. */
  | "retire";

/**
 * One shape for all four kinds rather than a union: every action is (source, destination, bytes,
 * reason), the renderer prints them as one table, and the applier switches on `kind` alone. A union
 * would buy precision the callers do not use and cost a cast at every render site.
 */
export interface ReclaimAction {
  kind: ReclaimActionKind;
  /** the checkout this acts on; `null` for `retire`, which acts on the store and is fleet-wide. */
  checkout: string | null;
  from: string;
  to: string | null;
  version: string;
  /** allocated bytes this action returns to the WSL filesystem. Never the host VHDX — see the runbook. */
  frees: number;
  reason: string;
  /** links to unlink before deleting a retired payload; empty for every other kind. */
  links: string[];
}

export type RetainedState = "unverified" | "harness-active" | "in-use" | "incomplete" | "foreign-link" | "pooled" | "required";

export interface RetainedRow {
  checkout: string;
  name: string;
  bytes: number;
  state: RetainedState;
  reason: string;
}

export interface ReclaimPlan {
  actions: ReclaimAction[];
  retained: RetainedRow[];
  /** allocated bytes the actions would return to the WSL filesystem. */
  freesBytes: number;
  keep: number;
  /** things the plan deliberately did NOT do, said out loud — a silent skip reads as "covered". */
  notes: string[];
}

/** Newest first. Numeric segment compare; a longer version wins a prefix tie (1.128.1 > 1.128). */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? -1) - (pa[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function join(...parts: string[]): string {
  // Deliberately not node:path — this module is pure and its inputs are already absolute POSIX paths.
  return parts.join("/").replace(/\/+/g, "/");
}

/**
 * Decide the whole plan. Deterministic and total: same inventory in, same actions out, no clock, no
 * filesystem, no randomness.
 *
 * `keep` is how many pooled versions survive, newest first. The default of 1 is the measured case —
 * two checkouts, two versions, one of them superseded — and is deliberately not 2: holding a second
 * ~1 GiB copy "just in case" is the cost this task exists to stop paying. `--keep 2` remains one flag
 * away for anyone who wants the old proposal's behaviour.
 */
export function planVscodeTestReclaim(inv: CacheInventory, opts?: { keep?: number }): ReclaimPlan {
  const keep = Math.max(1, opts?.keep ?? 1);
  const actions: ReclaimAction[] = [];
  const retained: RetainedRow[] = [];
  const notes: string[] = [];

  const retain = (checkout: string, entry: CacheEntry, state: RetainedState, reason: string): void => {
    retained.push({ checkout, name: entry.name, bytes: entry.bytes, state, reason });
  };

  // Fail-closed: with no live-process measurement we cannot say a payload is idle, and "probably idle"
  // is exactly the plausible-value-where-a-refusal-belongs shape this repo keeps catching.
  if (inv.liveProbe !== "measured") {
    for (const checkout of inv.checkouts) {
      for (const entry of checkout.entries) {
        retain(checkout.path, entry, "unverified", "the live-process probe could not run, so no payload can be shown to be idle");
      }
    }
    notes.push("the live-process probe could not run (/proc unreadable) — nothing was planned");
    return { actions, retained, freesBytes: 0, keep, notes };
  }

  /** Versions the store holds, updated as the plan pools more of them. */
  const pooled = new Map<string, { version: string; name: string; bytes: number; liveRefs: string[] }>();
  for (const e of inv.store.entries) pooled.set(e.name, { version: e.version, name: e.name, bytes: e.bytes, liveRefs: e.liveRefs });

  /** Versions each checkout can still resolve after pooling — links count, that is the whole point. */
  const reachable = new Map<string, Set<string>>();
  const reach = (checkout: string): Set<string> => {
    const found = reachable.get(checkout) ?? new Set<string>();
    reachable.set(checkout, found);
    return found;
  };

  // 1. Pool. One pass, input order, so the plan reads like the fleet.
  for (const checkout of inv.checkouts) {
    if (!checkout.cacheExists) continue;
    for (const entry of checkout.entries) {
      reach(checkout.path).add(entry.version);
      const at = join(checkout.cachePath, entry.name);

      if (checkout.harnessActive) {
        retain(checkout.path, entry, "harness-active", "the editor-host harness is running in this checkout");
        continue;
      }
      if (entry.liveRefs.length > 0) {
        retain(checkout.path, entry, "in-use", `held by a live process (${entry.liveRefs.join("; ")})`);
        continue;
      }
      if (entry.shape === "other-link") {
        retain(checkout.path, entry, "foreign-link", "a symlink Tachyon did not create — not ours to retarget");
        continue;
      }
      if (entry.shape === "store-link") {
        retain(checkout.path, entry, "pooled", "already a link into the shared store");
        continue;
      }
      if (!entry.complete) {
        retain(checkout.path, entry, "incomplete", `no ${COMPLETE_MARKER} marker — a download is in flight or died mid-way`);
        continue;
      }

      const already = pooled.get(entry.name);
      if (already) {
        actions.push({
          kind: "dedupe",
          checkout: checkout.path,
          from: at,
          to: join(inv.store.path, entry.name),
          version: entry.version,
          frees: entry.bytes,
          reason: "the shared store already holds this exact version",
          links: [],
        });
        continue;
      }
      if (!inv.store.sameDevice) {
        retain(checkout.path, entry, "required", "the shared store is on another filesystem, so pooling would be a copy rather than a rename");
        continue;
      }
      pooled.set(entry.name, { version: entry.version, name: entry.name, bytes: entry.bytes, liveRefs: [] });
      actions.push({
        kind: "adopt",
        checkout: checkout.path,
        from: at,
        to: join(inv.store.path, entry.name),
        version: entry.version,
        frees: 0,
        reason: "moved into the shared store; a symlink stays behind, so this checkout resolves it exactly as before",
        links: [],
      });
    }
  }

  if (!inv.store.sameDevice) {
    notes.push(`the shared store ${inv.store.path} is on a different filesystem than the checkouts — pooling was skipped rather than copying gigabytes`);
  }

  // 2. What may be retired. Newest `keep` survive; the rest are candidates until a checkout objects.
  const byVersionDesc = [...pooled.values()].sort((a, b) => compareVersionsDesc(a.version, b.version));
  const kept = byVersionDesc.slice(0, keep);
  const retireSet = new Map(byVersionDesc.slice(keep).map((p) => [p.name, p]));
  const newestKept = kept[0];

  const mutatable = (c: CheckoutCache): boolean => !c.harnessActive;
  const withCache = inv.checkouts.filter((c) => c.cacheExists);

  // A pooled payload a process is executing is off the table regardless of how superseded it is. This
  // is where a running editor host appears once versions are shared: `/proc/<pid>/exe` follows the
  // symlink, so the checkout looks idle and the store does not.
  for (const [name, p] of [...retireSet]) {
    if (p.liveRefs.length === 0) continue;
    retireSet.delete(name);
    notes.push(`kept ${name}: held by a live process (${p.liveRefs.join("; ")})`);
  }

  // A checkout we may not mutate keeps its newest reachable version, whatever the keep rule said. It
  // cannot be handed a link, so taking its payload away would strand it offline.
  for (const checkout of withCache) {
    if (mutatable(checkout)) continue;
    const versions = [...reach(checkout.path)].sort(compareVersionsDesc);
    const newest = versions[0];
    if (!newest) continue;
    for (const [name, p] of [...retireSet]) {
      if (p.version === newest) {
        retireSet.delete(name);
        notes.push(`kept ${name}: ${checkout.path} still resolves it and cannot be relinked while its harness is running`);
      }
    }
  }

  // 3. Links, emitted ONLY where a retire would otherwise strand a checkout. Provisioning a version a
  //    checkout never asked for is a mutation with no request behind it, so it is not done for free.
  const survives = (version: string): boolean => ![...retireSet.values()].some((p) => p.version === version);
  for (const checkout of withCache) {
    if (!newestKept) break;
    const versions = [...reach(checkout.path)];
    if (versions.length === 0 || versions.some(survives)) continue;
    if (!mutatable(checkout)) continue; // already handled above; nothing left to strand it with
    actions.push({
      kind: "link",
      checkout: checkout.path,
      from: join(inv.store.path, newestKept.name),
      to: join(checkout.cachePath, newestKept.name),
      version: newestKept.version,
      frees: 0,
      reason: `every version this checkout resolves is being retired — linked ${newestKept.name} first so its offline resolution never gets worse`,
      links: [],
    });
    reach(checkout.path).add(newestKept.version);
  }

  // 4. Retire, last, and only from the store. A checkout's own copy that was never pooled (in use,
  //    incomplete, foreign) is not reachable from here and is never deleted by this plan.
  for (const p of retireSet.values()) {
    // ONLY real links: an entry that is already a link into the store, or one this plan is about to
    // turn into one. A same-named directory that was never pooled (in use, incomplete, foreign) stays
    // exactly where it is — `unlink` on a directory would fail, and deleting it is not this action.
    const links = withCache
      .filter(
        (c) =>
          c.entries.some((e) => e.name === p.name && e.shape === "store-link") ||
          actions.some((a) => (a.kind === "adopt" || a.kind === "dedupe" || a.kind === "link") && a.checkout === c.path && a.version === p.version),
      )
      .map((c) => join(c.cachePath, p.name));
    actions.push({
      kind: "retire",
      checkout: null,
      from: join(inv.store.path, p.name),
      to: null,
      version: p.version,
      frees: p.bytes,
      reason: `superseded: ${kept.map((k) => k.version).join(", ")} ${kept.length === 1 ? "is" : "are"} pooled and every checkout resolves ${kept.length === 1 ? "it" : "one of them"}`,
      links,
    });
  }

  return { actions, retained, freesBytes: actions.reduce((sum, a) => sum + a.frees, 0), keep, notes };
}

/** The filesystem surface, injected so the applier is testable without a real disk. */
export interface ReclaimIo {
  mkdirp(p: string): void;
  rename(from: string, to: string): void;
  symlink(target: string, link: string): void;
  unlink(p: string): void;
  rmrf(p: string): void;
}

export interface ApplyResult {
  applied: ReclaimAction[];
  /** allocated bytes returned to the WSL filesystem — NOT to the Windows VHDX. */
  freedBytes: number;
  /** set when the plan was not executed at all; the applied list is then empty. */
  refused?: string;
  errors: string[];
}

/**
 * Execute a plan, or refuse.
 *
 * The refusal is the point of the function. `confirm` is not a convenience flag with a sensible
 * default — it is the whole difference between an inventory and a deletion, and the owner's decision
 * was that deletion is an act somebody performs, never an effect of something else running.
 *
 * A failed action ABORTS the rest. Half a plan is recoverable (the store and the links are both still
 * there to look at); a plan that kept deleting after its first surprise is not.
 */
export function applyReclaimPlan(plan: ReclaimPlan, o: { confirm: boolean; io: ReclaimIo }): ApplyResult {
  if (!o.confirm) {
    return {
      applied: [],
      freedBytes: 0,
      errors: [],
      refused: "nothing was changed: this is a dry run. Re-run with --confirm to execute the plan above.",
    };
  }

  const applied: ReclaimAction[] = [];
  const errors: string[] = [];
  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case "adopt":
          o.io.mkdirp(dirnameOf(action.to ?? ""));
          o.io.rename(action.from, action.to ?? "");
          o.io.symlink(action.to ?? "", action.from);
          break;
        case "dedupe":
          o.io.rmrf(action.from);
          o.io.symlink(action.to ?? "", action.from);
          break;
        case "link":
          o.io.mkdirp(dirnameOf(action.to ?? ""));
          o.io.symlink(action.from, action.to ?? "");
          break;
        case "retire":
          for (const link of action.links) o.io.unlink(link);
          o.io.rmrf(action.from);
          break;
      }
      applied.push(action);
    } catch (err) {
      errors.push(`${action.kind} ${action.from}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  return { applied, freedBytes: applied.reduce((sum, a) => sum + a.frees, 0), errors };
}

function dirnameOf(p: string): string {
  const at = p.lastIndexOf("/");
  return at <= 0 ? "/" : p.slice(0, at);
}

/**
 * The honesty rule of D7, in one function: a byte figure this tool reports is a WSL figure, and every
 * place it is printed says so. Confusing blocks returned to ext4 with space returned to Windows is
 * the single error the runbook exists to prevent, so it is not left to the caller to remember.
 */
export function wslBytes(n: number): string {
  return `${formatBytes(n)} in WSL (ext4)`;
}

export function formatBytes(n: number): string {
  const mib = n / 1024 / 1024;
  const human = mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
  return `${n.toLocaleString("en-US")} bytes (${human})`;
}

const HOST_NOTICE =
  `These bytes come back INSIDE WSL. The Windows VHDX does not shrink when files are deleted in Linux; ` +
  `that needs \`wsl --shutdown\` plus a host-side compact, which Tachyon does not automate. See ${RECLAIM_RUNBOOK}.`;

export function renderInventory(inv: CacheInventory): string {
  const out: string[] = [];
  out.push(`Editor-host cache inventory — ${inv.checkouts.length} checkout(s), store ${inv.store.path}`);
  out.push(`live-process probe: ${inv.liveProbe}`);
  out.push("");

  let total = 0;
  for (const checkout of inv.checkouts) {
    if (!checkout.cacheExists) {
      out.push(`${checkout.path}\n  no ${VSCODE_TEST_DIR} — this checkout has never run the editor-host harness`);
      continue;
    }
    out.push(`${checkout.path}${checkout.harnessActive ? "  [harness running]" : ""}`);
    for (const entry of checkout.entries) {
      total += entry.shape === "dir" ? entry.bytes : 0;
      const held = entry.liveRefs.length > 0 ? `  held by ${entry.liveRefs.join("; ")}` : "";
      out.push(`  ${entry.name.padEnd(28)} ${entry.shape.padEnd(10)} ${entry.complete ? "" : "INCOMPLETE "}${formatBytes(entry.bytes)}${held}`);
    }
    out.push(`  user-data + extensions: ${formatBytes(checkout.stateBytes)} (per-checkout state, never pooled or deleted)`);
  }

  out.push("");
  for (const entry of inv.store.entries) {
    total += entry.bytes;
    out.push(`  ${inv.store.path}/${entry.name.padEnd(28)} pooled     ${formatBytes(entry.bytes)}`);
  }
  out.push("");
  out.push(`Editor-host payload a reclaim could pool or free: ${wslBytes(total)}.`);
  out.push(HOST_NOTICE);
  return out.join("\n");
}

export function renderReclaimPlan(plan: ReclaimPlan, o: { confirm: boolean }): string {
  const out: string[] = [];
  out.push(`Reclaim plan (keep=${plan.keep}) — ${plan.actions.length} action(s)${o.confirm ? "" : ", DRY RUN"}`);
  out.push("");
  for (const action of plan.actions) {
    out.push(`  ${action.kind.padEnd(7)} ${action.version.padEnd(9)} ${action.from}`);
    if (action.to) out.push(`          -> ${action.to}`);
    for (const link of action.links) out.push(`          drop link ${link}`);
    out.push(`          ${action.reason}`);
    out.push(`          frees ${action.frees === 0 ? "0 bytes in WSL (this step only makes the payload shareable)" : wslBytes(action.frees)}`);
  }
  if (plan.actions.length === 0) out.push("  (nothing to do)");

  if (plan.retained.length > 0) {
    out.push("");
    out.push("Kept, and why:");
    for (const row of plan.retained) out.push(`  ${row.state.padEnd(14)} ${row.checkout}/${VSCODE_TEST_DIR}/${row.name} — ${row.reason}`);
  }
  for (const note of plan.notes) out.push(`  note: ${note}`);

  out.push("");
  out.push(`Total this plan frees: ${wslBytes(plan.freesBytes)}.`);
  out.push(HOST_NOTICE);
  if (!o.confirm) out.push("Dry run: nothing above has been done. Re-run with --confirm to execute it.");
  return out.join("\n");
}
