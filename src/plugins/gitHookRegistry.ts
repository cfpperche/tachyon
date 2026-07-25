/**
 * spec 264 — the managed git-hook store under `.tachyon/githooks/` (Tachyon-OWNED; gitignored, reconstructable
 * from the lockfile via repair). Pure I/O primitives the engine composes; the generated dispatcher (task 4)
 * consumes the published snapshot.
 *
 * Layout:
 *   .tachyon/githooks/
 *     leaves/<contentHash>      content-addressed leaf scripts (0755) — a copied payload script, a captured
 *                               prior user hook, or a generated argv wrapper. Immutable by content address.
 *     registry.json             the IMMUTABLE registry snapshot (per-event leaves + captured prior hook +
 *                               a generation + a self-integrity hash); atomically published, never references
 *                               a missing leaf.
 *     ownership.json            repo-level ownership of core.hooksPath: { claimedFrom, managedPath, leafRefs
 *                               across ALL events, generation }.
 *     .lock/                    an mkdir-based advisory repo lock for install/remove.
 *
 * Fail-closed: a corrupt registry/ownership is an ERROR, never a silent "empty" (which would disable a gate).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const GITHOOKS_REL = ".tachyon/githooks";

/**
 * Git events whose CONTRACT IS STDIN: git feeds the hook data the leaf must read to do its job. `pre-push`
 * gets one line per ref (`<local ref> <local sha> <remote ref> <remote sha>`), which is the only way a gate
 * can scope itself to a protected branch instead of taxing every push.
 *
 * This is a per-event property, not a preference: for such an event the dispatcher BUFFERS git's stdin once
 * and replays it to every leaf, so a chain of N leaves does not leave N-1 of them starved by the first
 * reader. Events absent here get `/dev/null` — explicitly, so a leaf can never observe dispatcher-internal
 * bytes. Buffering is not unconditional because an event that receives no stdin may be attached to a
 * terminal, where an unconditional read would hang the hook.
 *
 * Kept beside the dispatcher that consumes it rather than beside `GIT_HOOK_EVENTS` (the manifest's input
 * allowlist); `gitHookStdinEventsAreAllowlisted` is the executable guard against the two drifting apart.
 */
export const GIT_HOOK_STDIN_EVENTS: ReadonlySet<string> = new Set(["pre-push"]);

/**
 * Version of the GENERATED dispatcher template. The dispatcher is product code Tachyon writes into a
 * workspace, so a fix to it ships in an engine — but the bytes on disk were written by whichever engine
 * installed the plugin, and nothing used to bring them forward. A harness could therefore stay behind its
 * engine indefinitely, with no signal, so a dispatcher fix only reached a user who happened to reinstall an
 * unrelated plugin (t-c3b0a5). Stamping the generated file makes its provenance a fact on disk rather than a
 * guess, which is what lets `reconcileGitHookHarness` bring a stale harness forward.
 *
 * BUMP THIS whenever `dispatcherScript` changes behavior. `dispatcherTemplateFingerprint` +
 * its pinned-fingerprint test fail the suite if you forget — a version nobody increments is decoration.
 *
 *   1 — pre-stamp dispatchers (never written with a stamp; recognized by its ABSENCE).
 *   2 — every leaf gets an explicit stdin; stdin-contract events buffer and replay git's stdin (t-6a8deb).
 */
export const DISPATCHER_TEMPLATE_VERSION = 2;

const TEMPLATE_STAMP_PREFIX = "# tachyon-dispatcher-template ";

const LEAVES_SUBDIR = "leaves";
const REGISTRY_FILE = "registry.json";
const OWNERSHIP_FILE = "ownership.json";
const LOCK_SUBDIR = ".lock";
const LOCK_STALE_MS = 60_000;

export class GitHookStoreError extends Error {}

/** One registered leaf in an event's chain. `contentHash` names its `leaves/<hash>` file. */
export interface RegistryLeaf {
  pluginId: string;
  contentHash: string;
  /** present when the leaf is an argv vector (the leaf file is a generated wrapper) — kept for audit/consent. */
  argv?: string[];
}

/** A captured prior user hook the dispatcher chains to FIRST. Its content is stored as a leaf too. */
export interface PriorHook {
  contentHash: string;
  /** identity bound into the consent fingerprint. */
  origin: { path: string; mode: number; type: "file" | "symlink"; symlinkTarget?: string };
}

export interface EventEntry {
  priorHook: PriorHook | null;
  /** registered leaves, sorted by canonical pluginId (deterministic dispatcher order). */
  leaves: RegistryLeaf[];
}

export interface RegistrySnapshot {
  schema: 1;
  generation: number;
  events: Record<string, EventEntry>;
  /** sha256 over the canonical {generation, events} — the dispatcher self-validates this. */
  integrity: string;
}

export interface OwnershipRecord {
  schema: 1;
  /** the prior core.hooksPath raw value Tachyon replaced (null = none was set). */
  claimedFrom: string | null;
  /** the value Tachyon set core.hooksPath to (workspace-relative, e.g. `.tachyon/githooks`). */
  managedPath: string;
  /** count of registered leaves across ALL events — restore core.hooksPath only when this hits 0. */
  leafRefs: number;
  generation: number;
}

// ── generated dispatcher + execution manifest (the sh the dispatcher reads) ──

/** Shell-quote a single token for a generated argv wrapper (single-quote, escape embedded quotes). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** A generated leaf for an argv vector. Stored as a content-addressed leaf so the dispatcher runs every
 *  step uniformly. (`exec` does PATH lookup only when arg0 has no slash — an absolute path, e.g. a
 *  spec-265-provisioned tool, avoids it.)
 *
 *  Spec 393: workspace-relative Tachyon launchers (`.tachyon/bin/_tachyon-tool` etc.) fall back to the
 *  primary checkout via `git rev-parse --git-common-dir` when the isolated worktree has no local bin —
 *  so pre-commit does not require a manual symlink on every worktree. */
export function argvWrapperScript(argv: string[]): string {
  if (argv.length === 0) {
    return `#!/bin/sh\n# Tachyon git-hook argv wrapper (generated) — spec 264.\nexit 0\n`;
  }
  const [cmd, ...rest] = argv;
  const restQuoted = rest.map(shQuote).join(" ");
  if (
    cmd === ".tachyon/bin/_tachyon-tool" ||
    cmd === ".tachyon/bin/_tachyon-data" ||
    cmd === ".tachyon/bin/_tachyon-external"
  ) {
    return `#!/bin/sh
# Tachyon git-hook argv wrapper (generated) — spec 264.
set -eu
CMD=${shQuote(cmd)}
if [ ! -x "$CMD" ]; then
  COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || COMMON=
  if [ -n "\${COMMON:-}" ]; then
    ALT="$(dirname "$COMMON")/$CMD"
    if [ -x "$ALT" ]; then CMD=$ALT; fi
  fi
fi
exec "$CMD"${restQuoted ? ` ${restQuoted}` : ""} "$@"
`;
  }
  return `#!/bin/sh\n# Tachyon git-hook argv wrapper (generated) — spec 264.\nexec ${argv.map(shQuote).join(" ")} "$@"\n`;
}

/** The flat, integrity-stamped execution manifest the dispatcher reads. Steps are `leaves/<hash>` relative to
 *  the managed dir, in order (prior hook first, then leaves). Line 1 is `#tachyon-integrity <sha256(body)>`. */
export function buildExecutionManifest(stepRelPaths: string[]): string {
  const body = `${stepRelPaths.join("\n")}\n`;
  const integrity = crypto.createHash("sha256").update(body).digest("hex");
  return `#tachyon-integrity ${integrity}\n${body}`;
}

/** The Tachyon-authored POSIX `sh` dispatcher for `event`: integrity-self-validate the manifest (fail-closed),
 *  preserve Git's env (+ only `TACHYON_` additions), run each step in order, run-all-aggregate (first non-zero
 *  exit propagates, but every step runs), a missing/non-exec step is fail-closed. NB: no `${...}` sh expansions
 *  here — they would collide with the TS template literal; the only TS interpolations are `${event}` and the
 *  stdin plumbing below.
 *
 *  STDIN: every leaf is invoked with an EXPLICIT stdin. The manifest is read on fd 3, never on fd 0, so the
 *  loop's own input can no longer leak into a leaf — which it did, leaving a `pre-push` gate reading an
 *  exhausted manifest instead of git's ref lines and passing every push in silence. For a stdin-contract
 *  event (`GIT_HOOK_STDIN_EVENTS`) git's stdin is buffered once to a temp file and replayed to each leaf, so
 *  chained leaves all see the same bytes; every other event gets `/dev/null`. */
export function dispatcherScript(event: string): string {
  const carriesStdin = GIT_HOOK_STDIN_EVENTS.has(event);
  // Buffer git's stdin ONCE (a pipe is single-read: without this, leaf 2..N would starve).
  const bufferStdin = carriesStdin
    ? `STDIN_BUF=$(mktemp) || { echo "tachyon: ${event} cannot buffer stdin (mktemp failed) — fail-closed" >&2; exit 1; }
trap 'rm -f "$STDIN_BUF"' EXIT HUP INT TERM
cat > "$STDIN_BUF"
`
    : "";
  const leafStdin = carriesStdin ? `< "$STDIN_BUF"` : "< /dev/null";
  return `#!/bin/sh
# Tachyon git-hook dispatcher (generated) — spec 264. Do not edit; managed by Tachyon.
${TEMPLATE_STAMP_PREFIX}${DISPATCHER_TEMPLATE_VERSION}
set -u
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MANIFEST="$DIR/${event}.run"
[ -f "$MANIFEST" ] || { echo "tachyon: ${event} manifest missing — fail-closed" >&2; exit 1; }
tachyon_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else echo "tachyon: no sha256 tool (sha256sum/shasum) — fail-closed" >&2; exit 1; fi
}
EXPECT=$(head -n 1 "$MANIFEST" | sed 's/^#tachyon-integrity //')
ACTUAL=$(tail -n +2 "$MANIFEST" | tachyon_sha256) || exit 1
[ "$EXPECT" = "$ACTUAL" ] || { echo "tachyon: ${event} manifest integrity mismatch — fail-closed" >&2; exit 1; }
export TACHYON_GITHOOK_EVENT="${event}"
${bufferStdin}RC=0
exec 3< "$MANIFEST"
read -r _HEADER <&3
while IFS= read -r STEP <&3; do
  [ -n "$STEP" ] || continue
  S="$DIR/$STEP"
  if [ ! -x "$S" ]; then echo "tachyon: ${event} step missing/not executable: $STEP — fail-closed" >&2; exit 1; fi
  "$S" "$@" ${leafStdin}
  C=$?
  if [ "$C" -ne 0 ] && [ "$RC" -eq 0 ]; then RC=$C; fi
done
exec 3<&-
exit "$RC"
`;
}

/** The template version stamped into a dispatcher ON DISK. An UNSTAMPED file is a pre-versioning dispatcher,
 *  which is version 1 — read as data, never inferred from the file's age or content. Returns null when the
 *  file is absent or unreadable (nothing to compare; the caller decides, and must not treat that as current). */
export function readDispatcherTemplateVersion(file: string): number | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n", 8)) {
    if (!line.startsWith(TEMPLATE_STAMP_PREFIX)) continue;
    const n = Number(line.slice(TEMPLATE_STAMP_PREFIX.length).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return 1; // present but unstamped → the original template
}

/** A content fingerprint of the CURRENT template, stamp line excluded, over both an ordinary event and a
 *  stdin-contract one (they generate different plumbing). Its only job is to make an un-bumped behavior
 *  change fail the suite: the pinned expectation lives in the test, so editing `dispatcherScript` without
 *  touching `DISPATCHER_TEMPLATE_VERSION` cannot slip through as "the version is fine, nothing changed". */
export function dispatcherTemplateFingerprint(): string {
  const strip = (s: string) => s.split("\n").filter((l) => !l.startsWith(TEMPLATE_STAMP_PREFIX)).join("\n");
  return crypto
    .createHash("sha256")
    .update(`${strip(dispatcherScript("pre-commit"))} ${strip(dispatcherScript("pre-push"))}`)
    .digest("hex");
}

/** Every stdin-contract event must be an event a manifest can actually declare. A `GIT_HOOK_STDIN_EVENTS`
 *  entry outside the manifest allowlist is dead plumbing; an allowlisted event silently missing here is the
 *  worse direction — its leaves would read `/dev/null` and the gate would pass everything. Callers pass the
 *  allowlist so this module stays free of a manifest import cycle. */
export function gitHookStdinEventsAreAllowlisted(allowlist: readonly string[]): { ok: boolean; unknown: string[] } {
  const known = new Set(allowlist);
  const unknown = [...GIT_HOOK_STDIN_EVENTS].filter((e) => !known.has(e)).sort();
  return { ok: unknown.length === 0, unknown };
}

/** Recursively key-sorted JSON for a stable integrity hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotIntegrity(generation: number, events: Record<string, EventEntry>): string {
  return crypto.createHash("sha256").update(canonical({ generation, events })).digest("hex");
}

function atomicWrite(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

export class GitHookStore {
  constructor(private readonly workspaceRoot: string) {}

  dir(): string { return path.join(this.workspaceRoot, GITHOOKS_REL); }
  private leavesDir(): string { return path.join(this.dir(), LEAVES_SUBDIR); }
  leafFile(contentHash: string): string { return path.join(this.leavesDir(), contentHash); }
  hasLeaf(contentHash: string): boolean { return fs.existsSync(this.leafFile(contentHash)); }

  /** Store a leaf by content address (0755), idempotent. Returns the content hash. */
  putLeaf(content: Buffer | string): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const file = this.leafFile(hash);
    if (fs.existsSync(file)) return hash; // content-addressed → identical content already present
    fs.mkdirSync(this.leavesDir(), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, buf, { mode: 0o755 });
      try { fs.renameSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" && fs.existsSync(file) === false) throw e; }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return hash;
  }

  /** Delete a leaf (caller has confirmed it is unreferenced). ENOENT is a no-op. */
  pruneLeaf(contentHash: string): void {
    fs.rmSync(this.leafFile(contentHash), { force: true });
  }

  // ── registry snapshot ──────────────────────────────────────────────────────

  /** Read + integrity-validate the snapshot. Absent → undefined; corrupt/tampered → throw (fail-closed). */
  readSnapshot(): RegistrySnapshot | undefined {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir(), REGISTRY_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new GitHookStoreError(`reading ${REGISTRY_FILE}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new GitHookStoreError(`${REGISTRY_FILE}: invalid JSON`); }
    const snap = raw as RegistrySnapshot;
    if (!snap || snap.schema !== 1 || typeof snap.generation !== "number" || typeof snap.events !== "object" || snap.events === null) {
      throw new GitHookStoreError(`${REGISTRY_FILE}: malformed snapshot`);
    }
    if (snapshotIntegrity(snap.generation, snap.events) !== snap.integrity) {
      throw new GitHookStoreError(`${REGISTRY_FILE}: integrity mismatch — registry was tampered`);
    }
    // never reference a missing leaf — a snapshot pointing at an absent leaf is corruption.
    for (const entry of Object.values(snap.events)) {
      for (const leaf of entry.leaves) if (!this.hasLeaf(leaf.contentHash)) throw new GitHookStoreError(`${REGISTRY_FILE}: references missing leaf ${leaf.contentHash}`);
      if (entry.priorHook && !this.hasLeaf(entry.priorHook.contentHash)) throw new GitHookStoreError(`${REGISTRY_FILE}: references missing prior-hook ${entry.priorHook.contentHash}`);
    }
    return snap;
  }

  /** Atomically publish a snapshot (stamps the integrity hash). Caller must hold the lock + have written every
   *  referenced leaf first (so the published snapshot never references a missing leaf). */
  writeSnapshot(generation: number, events: Record<string, EventEntry>): RegistrySnapshot {
    const integrity = snapshotIntegrity(generation, events);
    const snap: RegistrySnapshot = { schema: 1, generation, events, integrity };
    atomicWrite(path.join(this.dir(), REGISTRY_FILE), `${JSON.stringify(snap, null, 2)}\n`);
    return snap;
  }

  removeSnapshot(): void { fs.rmSync(path.join(this.dir(), REGISTRY_FILE), { force: true }); }

  // ── per-event dispatcher + manifest (what git actually runs) ─────────────────

  /** Absolute path to the dispatcher git invokes for `event` (= `<managed>/<event>`). */
  dispatcherFile(event: string): string { return path.join(this.dir(), event); }

  /** Write the generated dispatcher (0755) + the integrity-stamped execution manifest for an event. The
   *  caller must have `putLeaf`'d every step first (so the published manifest never references a missing leaf).
   *  `stepRelPaths` are `leaves/<hash>` paths in dispatcher order. */
  installEventArtifacts(event: string, stepRelPaths: string[]): void {
    atomicWrite(this.dispatcherFile(event), dispatcherScript(event), 0o755);
    atomicWrite(path.join(this.dir(), `${event}.run`), buildExecutionManifest(stepRelPaths));
  }

  /** Remove an event's dispatcher + manifest (the event no longer has any registered leaf). */
  removeEventArtifacts(event: string): void {
    fs.rmSync(this.dispatcherFile(event), { force: true });
    fs.rmSync(path.join(this.dir(), `${event}.run`), { force: true });
  }

  // ── ownership record ───────────────────────────────────────────────────────

  readOwnership(): OwnershipRecord | undefined {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir(), OWNERSHIP_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new GitHookStoreError(`reading ${OWNERSHIP_FILE}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new GitHookStoreError(`${OWNERSHIP_FILE}: invalid JSON`); }
    const o = raw as OwnershipRecord;
    if (!o || o.schema !== 1 || typeof o.managedPath !== "string" || typeof o.leafRefs !== "number" || typeof o.generation !== "number" || !(o.claimedFrom === null || typeof o.claimedFrom === "string")) {
      throw new GitHookStoreError(`${OWNERSHIP_FILE}: malformed ownership record`);
    }
    return o;
  }

  writeOwnership(record: OwnershipRecord): void {
    atomicWrite(path.join(this.dir(), OWNERSHIP_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  removeOwnership(): void { fs.rmSync(path.join(this.dir(), OWNERSHIP_FILE), { force: true }); }

  /** Remove the whole managed dir when it is empty of meaningful state (no registry, no ownership). */
  cleanupIfEmpty(): void {
    const d = this.dir();
    fs.rmSync(this.leavesDir(), { recursive: true, force: true });
    for (const sub of [LOCK_SUBDIR]) fs.rmSync(path.join(d, sub), { recursive: true, force: true });
    try { fs.rmdirSync(d); } catch { /* non-empty (registry/ownership still there) → leave it */ }
  }

  // ── repo lock (mkdir-atomic, with a stale break) ──────────────────────────────

  /** Acquire the repo lock; returns a release fn. Retries up to ~`waitMs`, breaks a stale lock older than
   *  LOCK_STALE_MS (a crashed holder must not deadlock install/remove forever). */
  async acquireLock(waitMs = 5_000): Promise<() => void> {
    const lockDir = path.join(this.dir(), LOCK_SUBDIR);
    fs.mkdirSync(this.dir(), { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(lockDir); // atomic
        fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
        return () => { fs.rmSync(lockDir, { recursive: true, force: true }); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // stale-break: a lock dir older than the staleness window is from a dead holder.
        try {
          const age = Date.now() - fs.statSync(lockDir).mtimeMs;
          if (age > LOCK_STALE_MS) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
        } catch { /* raced away — retry */ }
        if (Date.now() > deadline) throw new GitHookStoreError("git-hook repo lock is held — another install/remove is in progress");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}
