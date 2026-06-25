# 265 — plugin-tool-provisioning — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

### 2026-06-25 — origin

Spec B of the two-spec arc (264 git-hook target → 265 tool/binary provisioning). The maintainer ratified the safe binary model in discussion: **author-declares per-platform pinned `{url, sha256}`; Tachyon detects-first then fetches + checksum-verifies into a sandboxed `.tachyon/bin/`, human-authorized; no package manager, no system PATH pollution, no Tachyon-curated registry.** This is what makes the 264 git-hook gate trustworthy as fail-closed (the scanner binary reliably present). Sequenced AFTER 264 and re-validated once 264 ships.

### 2026-06-25 — codex spec review (NEEDS-REVISION → folded)

Adversarial codex review (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T202052Z-spec265-review/`). Verdict NEEDS-REVISION; folded into `spec.md`:

- **4 BLOCKERs:** (1) verify→execute TOCTOU → download to same-fs temp, hash, fsync, chmod, **atomic-rename to content-addressed immutable path**. (2) flat `.tachyon/bin/<tool>` is not a stable identity → `.tachyon/bin/<name>/<sha256>/<tool>`, re-hash before wiring. (3) detect-first too trusting → host-provided is **opt-in + exact version** (corrected my `>=` lean), reject relative/writable/untrusted PATH. (4) archive extraction must be first-class → `innerPath`+`binSha256` + reject traversal/symlink/hardlink/device/multiple/oversized.
- **HIGHs folded:** lockfile records full provenance (declaredUrl/finalUrl/artifactSha/binSha/installPath/hostDetected/referrers); refcount key = platform+artifactSha+binSha+innerPath+exeName; uninstall removes only lockfile-owned content-addressed files; exact platform resolution (process.platform/arch + uname + Rosetta + WSL + **musl-vs-glibc**); **sha256 = integrity not trust** (scary consent + publisher identity); HTTPS-only + bounded redirects + final-URL recorded; download resource limits; transactional provisioning (all tools before any activation).
- **MEDIUM/LOW folded:** post-verify smoke check (magic + `--version`); dynamic-lib/macOS-quarantine surfaced (not bypassed); per-tool consent; host-provided path revalidated each run; archives supported with strict single-file extraction; explicit clone/CI re-hydrate (no silent fetch); content-addressed namespacing; machine-readable error codes.
- **No blind accept:** every BLOCKER/HIGH was genuinely a real supply-chain/TOCTOU hole — accepted. The only softening: signatures (cosign/minisign) stay a deferred hardening (D6), not v1, since author-pinned sha256 + per-tool consent + publisher identity is a defensible v1 trust floor.

### 2026-06-25 — codex review round 2 (verification → folded)

Second pass (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T*-spec265-review2/`). **B4 CLOSED**; **B1/B2/B3 PARTIAL** → tightened:
- **Operational immutability** (was asserted, not enforced): `O_EXCL` no-overwrite create, `0700` private parents, owner + hard-link-count checks, re-hash before wiring AND before each execution (launcher) — D8.
- **Install identity = EXECUTABLE bytes** `binSha256`, not the archive/artifact hash; archive storage separated from executable storage — D8.
- **Host-provided** records the host binary hash (required), optional manifest `allowedHostSha256`, and full-path ownership+mode trust (not just "not relative/world-writable") — detect scenario.
- **Consent↔download provenance can't drift**: consented final URL must exactly match the post-consent download's final URL.
- **Archive metadata-first** (never materialize entries during traversal); **smoke-check inside the trust boundary** (after verify, minimal env, no repo cwd/sensitive env/network, timeouts, output caps).
- Closed round-1 OQ1 (explicit libc platform keys, D9) + OQ3/OQ4 (detect-first needs a reliable exact-version probe or it's not host-eligible, D10).

The architecture (author-pinned + fetch/verify + content-addressed + consent) held; round 2 hardened the TOCTOU/identity/trust edges. Signatures stay deferred (D6).

### 2026-06-25 — codex PLAN review (NEEDS-REVISION → folded into plan Hardening)

Adversarial review of `plan.md` (transcript: Agent0 `.agent0/.runtime-state/codex-exec/*plan265-review/`). The model held; 15 findings hardened the security-critical joints, all folded as H1–H11 + a task reorder (new task 0):

- **Launcher trust** must be lockfile-anchored, not a standalone `tools.json` (H1); re-hash→exec TOCTOU is a documented same-user threat boundary + best-effort `O_NOFOLLOW`/`fstat` (H2); `${tool:}` is argv-only + whole-token (no shell smuggling) (H3).
- **Consent↔fetch** binding: applyInstall re-resolves redirects + aborts on drift; pre-consent uses a defined bounded GET, not HEAD (H4/H5-method).
- **Crash-safety**: a transaction journal `.tachyon/transactions/<id>/` + startup GC — rollback-on-error needs recover-on-restart (H5); stale temp/staging GC (H7-cleanup).
- **Archive**: pick audited libs FIRST (not hand-rolled), single-file + duplicate-entry + pax/zip64 rejection, both caps (H6).
- **Refcount by PHYSICAL identity** (installPath/binSha), not plugin/logical names (H7).
- **Host-provided routes through the launcher** + revalidates before each exec (H8).
- **Platform precedence** explicit + tested (missing getconf, BusyBox ldd, Rosetta native-arm64-preference, WSL, musl) (H9).
- **Smoke-check isolation is best-effort** (honest), not "no network" (H10); **TLS hygiene** — fixture CA injected only into the fixture client, prod rejects bad certs (H11).
- **Reorder**: archive-lib + launcher-trust + transaction-journal + platform-precedence are settled in task 0 BEFORE the provisioning code that depends on them.

No blind accept: H2/H10 are framed as HONEST limits (same-user mutation + smoke-check network are outside a plain-Node v1's enforceable boundary) rather than over-promised.

### 2026-06-25 — TASK 0 design gates (settled before any provisioning code)

The four contracts the provisioning code depends on, concretized for codex review.

#### (a) Archive library — **tar.gz/tgz only in v1 via `tar-stream`; zip DEFERRED**

The project ships ZERO archive deps today (all `node:` builtins); Node has no native tar or zip parser. So this is a genuine build-vs-adapt gate (never hand-roll — H6).

**Decision: support `tar.gz`/`tgz` ONLY in v1, extracted with `tar-stream` (mafintosh) + the built-in `node:zlib` gunzip. `zip` is rejected at manifest load with a forward-compatible "not supported in v1" error.**

Rationale:
- The motivating tool (gitleaks) and the overwhelming majority of linux/macOS CLI release artifacts ship `.tar.gz`. `zip` is predominantly a Windows packaging artifact — and v1 explicitly excludes Windows (linux/wsl/mac only). Carrying a zip parser would add a second high-risk extractor for a format almost no supported-platform tool actually uses.
- One archive format = one parser = ONE attack surface for the highest-risk code in the spec (H6). Smaller is safer.
- `tar-stream` is a pure **streaming, metadata-first** tar parser: it emits `(header, stream, next)` per entry, so we inspect EVERY entry's metadata (type, name, linkname, size, mode) and decide to reject or stream BEFORE any byte is materialized to disk — exactly the H6 "metadata-first, no on-disk materialization, single-file" contract. Small, widely-used (node-tar-fs/tar-fs build on it), maintained.
- Decompression bound: pipe gzip through `node:zlib.createGunzip()` and count decompressed bytes through the stream, aborting at the cap — enforces BOTH a compressed-size cap (the downloaded artifact) and a decompressed-size cap (H6 zip-bomb defense).

**Rejected alternatives (documented):**
- **`tar` / node-tar (isaacs)** — the most-audited tar lib (npm itself uses it), but its API is oriented toward *extract-to-disk* (`tar.x`, `onentry` filters that still run inside an extraction). Enforcing "inspect all metadata first, materialize NOTHING except one verified file" is fighting the abstraction. `tar-stream` gives the raw entry-stream primitive we actually want. (node-tar remains the fallback if `tar-stream` proves insufficient.)
- **`adm-zip`** — loads the whole archive into memory and has a history of path-traversal CVEs; not streaming. Rejected on both safety and the memory-footprint axis.
- **`yauzl` (thejoshwolfe)** — the security-conscious *streaming* zip choice (no auto-extract, you drive entry iteration). This is the lib we'd adopt IF/when a supported-platform tool ships zip-only — added behind the SAME metadata-first contract, not in v1.
- **Hand-rolled tar/zip parser** — forbidden by H6 (the parser is the attack surface; do not author it).

**v1 tar-subset rule (codex (a) TIGHTEN — H6 pax/zip64/case-collision concretized for tar).** Generic reject-list (traversal/absolute/symlink/hardlink/device/special/multiple/over-cap) is necessary but not sufficient for tar specifically. Additionally:
- Validate the **FINAL decoded path** `tar-stream` surfaces (post name+`prefix` splice, post-pax-`path`-override, post-GNU-longname) — never the raw 100-byte `header.name`. The traversal/absolute/normalized-containment check runs on that final path.
- Reject any surfaced pseudo-entry / metadata override we don't explicitly model: pax **global** headers (`type: "pax-global-header"`), pax per-entry `path`/`linkpath`/`size` overrides that disagree with the payload, GNU `longname`/`longlink`, and GNU **sparse** files — unless a fixture proves `tar-stream` normalizes that case safely. Default-deny.
- Reject duplicate normalized paths, INCLUDING case-folded duplicates (default macOS APFS is case-insensitive) — two entries colliding to one `innerPath` is an attack.
- Required unit fixtures (crafted tars): pax `path` override, pax global header, GNU longname, GNU sparse, name+`prefix` traversal, duplicate normalized `innerPath`, case-folded duplicate.

Manifest impact: `archive.type ∈ {tar.gz, tgz}` for v1 (was `{tar.gz, tgz, zip}` in the spec/plan). A `zip` type loads-but-rejects with a clear, forward-compatible message. The plan/spec text is updated to match.

#### (b) Launcher trust model — lockfile-anchored, two validators, honest exec integrity (H1/H2 concretized; codex BLOCK folded)

**The trust root is explicit (codex b-2).** The integrity-bearing code is the **extension-bundled validator JS** (`dist/`-shipped, NOT workspace state) — it is trusted exactly as much as the extension itself. The on-disk `.tachyon/bin/_tachyon-tool` shim is NOT a trust root: it is **regenerated from the extension on every install/update** and **integrity-stamped** in the lockfile (a `launcherSha256`) exactly like the spec-264 dispatcher + execution-manifest (`gitHookRegistry.ts` `dispatcherScript`/`buildExecutionManifest`). The shim's only job is to locate the bundled validator + re-exec under it; a tampered shim is re-materialized on the next managed op, and the validator (not the shim) performs every check below. `tools.json` is a derived convenience cache only — every entry is re-checked against the lockfile.

`_tachyon-tool <name> <args...>` resolution (the validator algorithm; fail-closed at every step):
1. Resolve the workspace root + read `.tachyon/plugins.lock.json` (the SINGLE source of truth — NOT `tools.json` alone; H1).
2. Find the lockfile `tools[]` entry whose logical `name` matches; read `source` (`fetched`|`host-provided`), `installPath`/host `path`, `binSha256`, `resolvedPlatform`, optional `allowedHostSha256`.
3. **Two validators by `source` (codex b-1):**
   - **`fetched`** → assert the path is exactly `<.tachyon/bin>/<name>/<binSha256>/<exe>` (content-address shape); a path that doesn't encode its own hash is rejected. Then step 4 with `nlink == 1` required (a managed content-addressed file is never legitimately hardlinked).
   - **`host-provided`** → assert the path equals the recorded absolute host `path`; EVERY parent dir is owned by user/root and has no group/other write; then step 4 WITHOUT the `nlink == 1` invariant (package-manager binaries are routinely hardlinked — ownership/mode + per-exec hash carry the guarantee instead).
4. Open the file `O_NOFOLLOW` (no symlink swap), `fstat` the handle: regular file, owner == running uid, mode has no group/other write (+ `nlink == 1` for `fetched` only). Hash the bytes read THROUGH that fd; compare to `binSha256` (and `allowedHostSha256` when declared). Mismatch → fail-closed.
5. **Exec — honest about the mechanism (codex b-3).** Pure Node has NO `fexecve`. The Linux intent is: keep the `O_NOFOLLOW` fd open, hash through it, then `spawn("/proc/self/fd/3", args, { stdio:[...], /* fd 3 = the validated handle, inherited */ })` so the executed image IS the validated fd — closing the re-open path race. This requires the validated fd to be inherited at a known child fd number; a task-7 test MUST prove "swap the path after hashing → execution is unaffected." **If Node cannot guarantee that fd identity at spawn, the mechanism degrades to a best-effort re-stat-then-exec of the same path — identical to macOS** (no `/proc`: re-`fstat` the path immediately before `execv`). It is labelled best-effort, never "fexecve-equivalent."

**Threat boundary (honest, H2):** a same-uid attacker who can mutate files between `fstat` and `exec` already has full account control — OUTSIDE the threat model. The launcher closes the cross-user case (`0700` parents, owner/mode checks) and the accidental-corruption case (re-hash), and minimizes (Linux fd-exec) or best-effort-narrows (macOS re-stat) the same-user TOCTOU window. Documented as best-effort, never over-promised.

Language/shape note: the shim is a tiny Tachyon-authored **POSIX-sh** stub that locates + invokes the bundled validator via the embedded Node already required to run the extension. Final shape decided in task 7; the trust root + two-validator algorithm above is the contract it must implement.

#### (c) Transaction journal — `.tachyon/transactions/<id>/` + startup GC (H5)

Layout (a provisioning run is one transaction):
```
.tachyon/transactions/<txid>/
  meta.json        # { txid, startedAtIso, pid, ownerUid, phase, plugin, platform }
  staging/         # downloaded+verified binaries land here FIRST (same filesystem as .tachyon/bin/)
  journal.jsonl    # append-only step log: each provisioned tool's installPath + binSha + "staged"|"committed"
```
- `txid` = a random hex id passed in (scripts can't call `Math.random()`/`Date.now()` — the engine mints it from `crypto.randomBytes`; the ISO time is stamped by the caller).
- **Commit point:** all tools download→verify→land in `staging/`, then are atomically renamed (`rename(2)`, same-fs) into the live content-addressed `.tachyon/bin/<name>/<binSha>/<exe>`, THEN `tools.json` is written, THEN the lockfile is committed by atomic rename. Activation material (settings/skills/mcp/git-hooks from 264) is staged and flips only after the lockfile commit.
- **Crash semantics (codex (c) — corrected, was overclaimed).** Activation can NEVER reference a missing binary: hooks flip only after the lockfile commit, which is after the binaries are live. But a crash AFTER a binary is renamed into `.tachyon/bin/` and BEFORE the lockfile commit CAN leave an **orphaned, unreferenced content-addressed binary** (no live hook points at it; it's just disk litter). So the honest claim is: *"a crash before lockfile commit may leave unreferenced content-addressed binaries, but cannot activate any hook against a missing/unverified tool."* The orphan is reclaimed by GC.
- **Startup GC** (`gcAbandonedTransactions(root)` on engine init) — **holds the SAME repo lock as install** and re-reads the lockfile immediately before any deletion (codex (c) race fix). Three sweeps, all guarded by `ownerUid == running uid`:
  1. Transaction dirs: `transactions/<id>/` with `meta.json` missing/corrupt OR `startedAtIso` older than TTL (24h) → `rm -rf` (after confirming the lockfile doesn't reference its staged paths).
  2. Stale `*.staging-*` temp dirs (the `fetcher.ts` pattern) under the same age+owner guard.
  3. **Orphaned content-addressed binaries** (codex (c) — NEW): walk `.tachyon/bin/<name>/<sha>/<exe>` and delete any whose `(installPath, binSha256)` no physical-identity refcount (H7) in the current lockfile references. This is the recover-on-restart half of "rollback-on-error" — H5.
  - **Never promote** committed-but-unlocked transaction content: if the lockfile doesn't reference it, it's an aborted install → delete after TTL; if the lockfile already references the same live content path, keep the binary and remove only the transaction dir.

#### (d) Platform-resolution precedence (H9)

`resolvePlatform()` returns one of the explicit libc-qualified keys `{linux-x64-glibc, linux-x64-musl, linux-arm64-glibc, linux-arm64-musl, darwin-x64, darwin-arm64}` or a typed `UnsupportedPlatformError{code, detail}`. Precedence order:
1. **OS** from `process.platform`: `linux`/`darwin` → continue; `win32` → `UNSUPPORTED_OS` (Windows excluded in v1); anything else → `UNSUPPORTED_OS`. WSL is `linux` (no special-case — it reports `linux`).
2. **Arch — the TARGET binary's ABI, not blindly the Node ABI (codex (d) correction).** `process.arch` is the Node userland ABI, which is NOT always the right answer for an externally-exec'd tool:
   - **Darwin:** detect the true HARDWARE arch via `uname -m` + `sysctl.proc_translated` (`sysctl -n hw.optional.arm64` corroborates). On arm64 hardware — *even when Node itself is an x64 image running under Rosetta translation* — prefer a native `darwin-arm64` tool when the manifest pins one; fall back to `darwin-x64` only when there is no arm64 pin (recorded). This is the whole point of (3) and it must NOT be defeated by an x64 Node.
   - **Linux:** `process.arch` is a reasonable userland-ABI signal; corroborate with `uname -m`. On AGREEMENT → that arch. On DISAGREEMENT → record it and **fail closed with `AMBIGUOUS_ARCH`** rather than silently picking the wrong binary (a wrong-arch native binary won't run). Any non-{x64,arm64} arch → `UNSUPPORTED_ARCH`.
3. **Rosetta** (darwin) is folded into (2): the hardware-arch detection above is what makes "prefer native arm64 even under translation" real.
4. **libc** (linux only): probe `getconf GNU_LIBC_VERSION` → glibc; else `ldd --version` (GNU libc banner → glibc; "musl" banner → musl); if neither resolves (BusyBox `ldd`, missing `getconf`) → **fail with `LIBC_UNRESOLVED`** rather than guessing — a wrong libc yields a binary that won't load. **Static binaries (codex (d)):** a fully-static (libc-agnostic) tool is legitimate but v1 has NO `linux-*-static` key — the author must either pin the same artifact under BOTH the `-glibc` and `-musl` keys, or wait for a future explicit static key. v1 never guesses a libc.
All probes are corroborating, fail-closed, and unit-tested with mocked probe outputs (missing getconf, BusyBox ldd, Rosetta x64-Node-on-arm64, WSL, musl container, x64/arm64 disagreement).

#### TASK 0 — codex review (NEEDS-REVISION → folded)

Adversarial codex review of the four gates (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T231554Z-you-are-reviewing-the-task-0-design-gate-decisio/`). Verdict NEEDS-REVISION; **all four folded above, none blind-accepted** (each was a real correctness/honesty hole):
- **(a) TIGHTEN** — agreed tar.gz-only + `tar-stream`; added the **v1 tar-subset rule** (validate FINAL decoded path; default-deny pax-global/pax-override/GNU-longname/GNU-sparse; reject case-folded duplicate `innerPath`; named fixtures).
- **(b) BLOCK** — (1) split fetched vs **host-provided** validators (host paths aren't content-addressed → can't reuse the shape assertion); (2) named the **trust root** (bundled validator JS is trusted; the on-disk shim is regenerated-per-install + lockfile-`launcherSha256`-stamped like the 264 dispatcher); (3) stopped overclaiming `/proc/self/fd` — specified the fd-inheritance mechanism + a proving test, with honest degrade to best-effort re-stat (= macOS) if Node can't guarantee fd identity; `nlink==1` is fetched-only.
- **(c) TIGHTEN** — corrected the false "live tree untouched" crash claim (orphaned binary possible post-rename/pre-commit); GC shares the install **repo lock** + re-reads lockfile before deleting; added an **orphaned-content-addressed-binary sweep** by physical refcount; never promote committed-but-unlocked content.
- **(d) TIGHTEN** — fixed the arch rule: **darwin uses hardware arch** (`uname -m` + `proc_translated`) so an x64 Node under Rosetta still prefers native `darwin-arm64`; **linux fails closed (`AMBIGUOUS_ARCH`)** on process.arch↔uname disagreement; static binaries need dual pins (no guessing).

The four gates are settled. Provisioning code (task 1+) may proceed against these contracts.

## Deviations

- **Spec/plan said archive `type ∈ {tar.gz, tgz, zip}`; task 0 narrows v1 to `{tar.gz, tgz}`** (zip deferred — see (a) above). Forward-compatible: a zip pin loads-but-rejects with a clear message.

- **Task 5 archive extraction — flush-before-advance race (fixed while building).** The extractor first
  advanced to the next tar entry on the READ stream's `end`, but the post-`finish` re-hash then raced a
  not-yet-flushed write → intermittent happy-path `BIN_SHA_MISMATCH`. Fixed by gating `next()`/`foundTemp`
  on the WRITE stream's `finish` (full disk flush), not the read `end`. Tar-stream's pax/GNU long-name
  handling was confirmed safe: a 150-char `innerPath` round-trips with the resolved name (test included).

## Tradeoffs

- **One archive format (tar.gz) vs two**: dropping zip removes a high-risk extractor for a format almost no linux/mac tool ships, at the cost of rejecting a hypothetical zip-only supported-platform tool until v2 (`yauzl` is the pre-chosen lib for that). Net: smaller attack surface now, clean upgrade path later.

## Open questions
