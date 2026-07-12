# SDD 368 — CAP_SYS_PTRACE worktree-binding audit helper feasibility spike

Date: 2026-07-12  
Host: `DESKTOP-BGG95NA`, WSL2  
Investigators: `processAuditHelperGrokR1` (initial spike), `processAuditHelperGrokFixR2` (Sonnet R1 F1/F2 under `j-2cf388e6c4cf`), `processAuditHelperGrokFixR3` (Sonnet R2 H1/H2 correction under `j-df883330e9cf`), `processAuditHelperGrokFixR4` (Grok R4 `pidfd_getfd` fallback under `j-aec448bf6364`), `processAuditHelperGrokFixR5` (Grok R5 FDSize-bounded pidfd under `j-de678ede82c3`)  
Scope: prototype read-only same-UID worktree-binding audit helper under `.tachyon/studies` plus disposable `/tmp` build/install only; no production ProcessFence adapter; no production/tests/config changes except the generated gate test.  
Prior studies: `.tachyon/studies/368-process-fence-spike.md` (audit `EACCES` blocker), `.tachyon/studies/368-process-fence-cgroup-spike.md` (cgroup containment accepted independently).  
Reviews: R1 `fe72ca16` F1/F2; R2 FINDINGS H1 nondeterministic race + H2 per-process swap/restore gap (`.tachyon/reviews/368-process-audit-helper-r2.md`); R3 ACCEPT `cba4894c`; R4 ACCEPT `c81256d7` (nr_open primary bound refused on this host); capability tradeoff `j-3ea903e0ce8b` + coordinator corrections `j-aec448bf6364` / `j-de678ede82c3`.

## Verdict

**BLOCKED.** The helper prototype is implemented, hardened-compiled, checksum-pinned, and empirically shown to:

1. reproduce the accepted fail-closed result **`unknown`** without capability when same-UID `/proc` targets return `EACCES`;
2. still detect a live open-FD binding to a canonical target while remaining `unknown` because the scan is incomplete;
3. emit only machine-readable state + match pid/starttime/kind/fd evidence + bounded unknown reasons (no unrelated process path strings);
4. refuse to claim a complete no-hit (`empty`) scan on this host without capability;
5. **(F1 closed)** independently `realpath()` the caller target, require **byte-exact** equality with the resolved canonical absolute directory, pin identity via `O_PATH|O_DIRECTORY|O_CLOEXEC` + `fstat` `st_dev`/`st_ino`, and revalidate path+identity before and after every audit pass (symlink alias → refuse; rename/replacement/deletion/identity drift → `unknown`, never silent under-report/`empty`);
6. **(F2 closed)** keep `capability_loss` as a sticky counted/reported unknown reason across fixed-point passes so `state=unknown` cannot print `unknown_count=0`/no reason after an earlier-pass loss observation;
7. **(H1 closed — practical test truth)** expose a **compile-time `TEST_ONLY`** ready/release synchronization seam (absent from the hardened production binary) so the generated gate can **require** the barrier and deterministically force rename/replacement → specific `target_*` unknown, with **no** ambient-`EACCES` race-miss fallback;
8. **(H2 practical close)** revalidate the pinned target and obtain its live `/proc/self/fd` canonical path **around each process/link observation**, compare candidates against that live path, and fail closed with `target_*` on any pre/post path/identity drift (pass-level checks preserved);
9. **(R4 scaffolding retained; R5 bound fix)** on same-UID `/proc/<pid>/fd` `opendir` `EACCES`/`EPERM` only, fall back to raw `pidfd_open` + `pidfd_getfd` probes over **`/proc/<pid>/status` `FDSize`** (kernel fdtable capacity — primary probe bound), **two complete scans** of `[0, FDSize)` with starttime + FDSize pre/mid/post **exact stability** (FDSize may expand or shrink; never assume monotonicity), monotonic deadline, exact occupied-evidence agreement (FD number + classification); **never** uses `RLIMIT_NOFILE` soft/hard as a completeness bound. Global `fs.nr_open` is **validation-only** (FDSize must not exceed it). Configured memory/deadline ceiling `PIDFD_FDSIZE_SAFE_MAX=1048576` refuse-closes oversize FDSize. `EBADF` = absence; `ESRCH`/`EPERM`/`EACCES`/`ENOSYS`/`EMFILE`/other → explicit unknown. On this host without capability, residual `(sd-pam)` (FDSize=128) reaches the fallback and fails closed as `pidfd_getfd_eperm` (honest incompleteness, not `empty`) — no longer blocked by host `fs.nr_open=2147483584`.

However, installing the authorized **file capability** `CAP_SYS_PTRACE` requires interactive credentials on this host:

- `sudo -n true` → `sudo: interactive authentication is required` (exit 1)
- `sudo -n setcap cap_sys_ptrace=ep <binary>` → same failure
- unprivileged `setcap` → `unable to set CAP_SETFCAP effective capability: Operation not permitted`

Per the spike contract: **do not claim feasibility** of a complete privileged audit when capability install is not already noninteractive. **No setcap was performed in this R5 round.** No `CAP_DAC_READ_SEARCH`. A capped empirical re-run against `(sd-pam)` is still required before any host-complete claim. This is **not** a PASS and **not** authorization to ship a production ProcessFence adapter or to treat `proven_empty` / default sequential handoff as closed.

### Irreducible residual (must stay explicit)

A **malicious same-UID** actor that coordinates **move+restore entirely between separate procfs syscalls** (inside the pre-observation revalidate → `readlink` → post-observation revalidate window, or any other multi-syscall gap) **cannot be mathematically excluded** by this `readlink`/`stat` primitive. Per-observation checks close practical accidental races and force fail-closed on held drift; they do **not** prove an atomic cross-process binding observation. **BLOCK production `proven_empty` / default adapter rollout** until the threat model is explicitly re-ratified or a stronger inode/subtree primitive is proven. Swap/restore characterization is covered in the gate test and leaves host incompleteness (`unknown`) without claiming `empty`.

## Contract under test

Accepted ProcessFence independent-audit predicate (unchanged):

| Result | Meaning |
|---|---|
| `empty` | complete no-hit scan of the declared domain |
| `survivors` | one or more matching cwd/root/FD bindings and no incomplete evidence |
| `unknown` | any unreadable / unstable / truncated / malformed / identity-drift / capability-loss evidence |

Helper requirements exercised:

- scan only processes whose **real UID** equals the invoker’s real UID;
- accept one **canonical absolute** directory target and **independently verify** it (`realpath` byte-exact match + `O_PATH` pin + every-pass pre/post revalidation + **per-observation** revalidation);
- never signal, ptrace-attach, write procfs, mutate the target, or expose unrelated process paths;
- inspect `cwd`, `root`, and every FD via `readlink` only (excluding the helper’s own target pin FD);
- strip a single trailing ` (deleted)` display suffix carefully for binding paths; treat pin-FD `(deleted)` as fail-closed target drift;
- pin and recheck `/proc/<pid>/stat` starttime around the per-pid scan;
- rescan vanishing processes to a bounded fixed point (max 8 passes);
- sticky `capability_loss` reason survives pass resets when observed;
- stable machine-readable stdout; exit `0 empty | 1 survivors | 2 unknown | 3 error`;
- compile with hardening flags; record source and **hardened** binary SHA-256;
- `TEST_ONLY` seam is compile-time guarded and **absent** from the hardened binary proposed for capability;
- test first without capability; attempt file capability only if `sudo -n` / setcap is noninteractive;
- never solicit, capture, cache, or bypass a password;
- remove any installed/temp binary after experiments and prove cleanup.

## Host facts (2026-07-12)

| Fact | Value |
|---|---|
| Kernel | `Linux 6.6.114.1-microsoft-standard-WSL2` x86_64 |
| Distro | Ubuntu (same host class as prior 368 spikes) |
| Virt | WSL2 (`DESKTOP-BGG95NA`) |
| UID | `1000:1000` (`goat`); effective capabilities empty |
| Yama | `ptrace_scope = 1` |
| `/proc` options | `rw,nosuid,nodev,noexec,noatime` (no `hidepid`) |
| Seccomp (investigator shell) | mode 2 + filter present; `NoNewPrivs=0` |
| CapBnd | includes CAP_SYS_PTRACE bit (bounding set allows file-cap raise if authorized) |
| `sudo -n` | fails: interactive authentication required |
| Same-UID `EACCES` sample | PID `1530` `systemd`, `1533` `(sd-pam)`, `1193083` `postgrest` |

## Artifacts

| Artifact | Path / value |
|---|---|
| Source | `.tachyon/studies/368-process-audit-helper.c` |
| Source SHA-256 | `e60d1cc8acc51bc811fd7a7c5f2a4c3c6a4068d07c57e6a95a077339a1b85014` |
| Binary SHA-256 (hardened, seam-free) | `856b0b78aecca1540a2eaee701032e9df436e709e100b0ea3f3944f542a36185` |
| TEST_ONLY binary | built only in the generated gate (`-DTEST_ONLY`); **not** capability candidate; different hash |
| Disposable build root | `/tmp/tachyon-368-audit-build-*` (removed after experiments) |
| Disposable targets | `/tmp/tachyon-368-audit-target-*` (removed after experiments) |
| Correction journals | R2 `j-2cf388e6c4cf`; R3 `j-df883330e9cf`; R4 `j-aec448bf6364`; R5 `j-de678ede82c3` on task `t-0b5723` |
| R1 / R2 / R3 reviews | `.tachyon/reviews/368-process-audit-helper-r1.md`, `…-r2.md`, `…-r3.md` |
| Capability tradeoff | `.tachyon/reviews/368-process-audit-capability-tradeoff.md` (soft-limit premise **superseded** by `j-aec448bf6364`; nr_open primary bound **superseded** by `j-de678ede82c3` FDSize) |

## Build (exact)

Hardened production build (checksum-pinned; **no** `-DTEST_ONLY`):

```bash
BUILDDIR=$(mktemp -d -p /tmp tachyon-368-audit-build-XXXXXX)
gcc -O2 -pipe \
  -Wall -Wextra -Werror \
  -fstack-protector-strong \
  -D_FORTIFY_SOURCE=2 \
  -fPIE -pie \
  -Wl,-z,relro,-z,now \
  -o "$BUILDDIR/process-audit-helper" \
  .tachyon/studies/368-process-audit-helper.c
sha256sum .tachyon/studies/368-process-audit-helper.c "$BUILDDIR/process-audit-helper"
# strings must NOT contain PAH_TEST_SEAM_DIR
```

TEST_ONLY build (gate barriers only; never propose for setcap):

```bash
gcc -O2 -pipe -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -fPIE -pie -Wl,-z,relro,-z,now -DTEST_ONLY \
  -o "$BUILDDIR/process-audit-helper-test" \
  .tachyon/studies/368-process-audit-helper.c
```

Observed:

```text
compile_ok
e60d1cc8acc51bc811fd7a7c5f2a4c3c6a4068d07c57e6a95a077339a1b85014  .tachyon/studies/368-process-audit-helper.c
856b0b78aecca1540a2eaee701032e9df436e709e100b0ea3f3944f542a36185  .../process-audit-helper
ELF 64-bit LSB pie executable, x86-64, dynamically linked
readelf: FLAGS BIND_NOW; FLAGS_1 NOW PIE
hardened strings: no PAH_TEST_SEAM_DIR / PAH_TEST_FORCE_PIDFD / PAH_TEST_SPAWN_HIGH_FD / PAH_TEST_FDSIZE / PAH_TEST_NR_OPEN
```

Hardening notes: PIE + full RELRO (`-Wl,-z,relro,-z,now`) + stack protector + FORTIFY. The binary is a spike prototype, not a production install target.

## Helper semantics (prototype)

Machine-readable lines (stable keys):

```text
state=empty|survivors|unknown
self_ruid=<uid>
target=<canonical-absolute-dir>
cap_sys_ptrace=yes|no
match_count=<n>
unknown_count=<n>
match pid=<pid> starttime=<ticks> kind=cwd|root
match pid=<pid> starttime=<ticks> kind=fd fd=<n>
unknown reason=<code> [pid=<pid>] [kind=...] [fd=<n>]
```

Unknown reason codes used: `eaccess`, `truncation`, `malformed_link`, `read_error`, `status_unreadable`, `stat_unreadable`, `fd_dir_error`, `identity_drift`, `capability_loss`, `proc_unreadable`, `pid_enum_truncated`, `instability_fixed_point`, `target_missing`, `target_path_drift`, `target_identity_drift`, `target_deleted`, `target_not_dir`, `target_fd_error`, plus pidfd reasons: `pidfd_nr_open_unreadable`, `pidfd_fdsize_missing`, `pidfd_fdsize_duplicate`, `pidfd_fdsize_malformed`, `pidfd_fdsize_zero`, `pidfd_fdsize_too_large`, `pidfd_fdsize_above_nr_open`, `pidfd_fdsize_changed`, `pidfd_deadline`, `pidfd_scan_disagreement`, `pidfd_occupied_overflow`, `pidfd_oom`, `pidfd_open_enosys`, `pidfd_open_eperm`, `pidfd_open_emfile`, `pidfd_open_error`, `pidfd_getfd_esrch`, `pidfd_getfd_eperm`, `pidfd_getfd_eacces`, `pidfd_getfd_enosys`, `pidfd_getfd_emfile`, `pidfd_getfd_error`.

Pre-scan refuse codes on stderr (exit 3): `error=target_not_absolute`, `error=target_not_canonical` (includes symlink alias where `realpath` ≠ input), `error=target_trailing_slash`, `error=target_unresolvable`, `error=target_open_failed`, `error=target_too_long`.

Report lists are bounded (`match` ≤ 256, `unknown` ≤ 64) with `*_truncated=yes omitted=N` when capped; counts remain total. Target revalidation failures use a critical report slot so TOCTOU reasons remain visible even when the EACCES report is saturated. Unrelated process path strings are never printed (only the caller-supplied `target=`).

State precedence implemented (fail-closed):

1. any incomplete evidence → `unknown` (exit 2);
2. else any match → `survivors` (exit 1);
3. else → `empty` (exit 0).

Matches may still be listed under `unknown` so an operator can see detected bindings without treating the scan as complete.

### Target pin + revalidation (F1 + H2 practical)

1. Syntactic checks (absolute, no `/./` `/../`, no trailing slash).
2. `realpath(target)` must succeed and equal the caller string **byte-for-byte** (symlink components → `error=target_not_canonical`, exit 3).
3. `open(target, O_PATH|O_DIRECTORY|O_CLOEXEC)`; `fstat` pins `st_dev`+`st_ino`.
4. Before and after **every** fixed-point pass: re-`realpath` + path `stat` + O_PATH `fstat` + `readlink(/proc/self/fd/<pin>)` must match the pinned path and identity; `(deleted)` suffix on the pin FD → `target_deleted`.
5. **Around each process/link observation:** revalidate and capture the pin’s **live** `/proc/self/fd` path; compare the process link candidate against that live path; revalidate again after the observation. Any pre/post path or identity drift → `target_*` unknown (sticky fail-closed; never under-report as `empty`).
6. The helper’s own pin FD is excluded from FD match enumeration so the pin is not reported as a binding.

### TEST_ONLY synchronization seam (H1)

Compiled only with `-DTEST_ONLY` (not in the hardened capability candidate):

| Env | Role |
|---|---|
| `PAH_TEST_SEAM_DIR` | directory for `<phase>.ready` / `<phase>.release` markers |
| `PAH_TEST_SEAM_PHASE` | exact phase to arm: `post_pin` or `obs` (others no-op) |

Phases:

- `post_pin` — immediately after successful initial pin (and recheck after release);
- `obs` — once at the first per-link observation (recheck after release before continuing).

The generated gate **requires** the ready marker, forces rename/replacement under parent control, and asserts a specific `target_*` reason. There is **no** `if (attacked) … else ambient eaccess` fallback.

### Sticky capability_loss (F2)

Per-pass counters reset each fixed-point iteration, but `saw_cap_loss` is sticky. Once set (started with effective CAP_SYS_PTRACE and later `capget` shows it gone), every subsequent pass re-adds `unknown reason=capability_loss` so the final printed output cannot be `state=unknown` with `unknown_count=0` and no reason line.

### R5 pidfd_getfd fallback — FDSize-bounded (`j-de678ede82c3`)

**Trigger (production):** only when same-UID `/proc/<pid>/fd` `opendir` fails with `EACCES` or `EPERM`. Normal readable `readdir` path is unchanged. R4 scaffolding (raw syscalls, two-scan agreement, errno map, cleanup, privacy) is preserved.

**Completeness bound (R5):** **`/proc/<pid>/status` `FDSize`** (kernel fdtable capacity), not `RLIMIT_NOFILE` soft/hard and not global `fs.nr_open` as the primary probe range. A process may retain already-open FDs above a subsequently lowered soft limit — probing `[0, soft)` is **incomplete**. R4 used stable `fs.nr_open` as the probe bound; on this host `fs.nr_open=2147483584` exceeded `SAFE_MAX` and refused every fallback — Sonnet R4 noted real `(sd-pam)` FDSize=128 and high-`dup2` expansion, so R5 switches the bound.

**Global `fs.nr_open`:** validation ceiling only (`FDSize` must be `≤ nr_open`). Unreadable/zero → `pidfd_nr_open_unreadable`. Large host values are accepted for validation.

**FDSize parse (strict, same status snapshot as real `Uid`):** exactly one well-formed `Uid:` and one well-formed `FDSize:` line; missing → `pidfd_fdsize_missing`; duplicate → `pidfd_fdsize_duplicate`; junk → `pidfd_fdsize_malformed`; zero → `pidfd_fdsize_zero`; `> nr_open` → `pidfd_fdsize_above_nr_open`; `> PIDFD_FDSIZE_SAFE_MAX` (1048576) → `pidfd_fdsize_too_large`. Uid must match the domain real UID or → `identity_drift`.

**Algorithm:**

1. Read+validate FDSize (with Uid facts + nr_open ceiling + SAFE_MAX).
2. `pidfd_open(pid, 0)`; pin `/proc/<pid>/stat` starttime; re-read FDSize (must match exactly — no monotonicity assumption); close every pidfd/dup on all paths.
3. Monotonic deadline (`PIDFD_SCAN_DEADLINE_MS=10000`) for the whole two-scan of that process.
4. **Scan A:** for each candidate FD in `[0, FDSize)`, `pidfd_getfd`; `EBADF` = hole (absence); success → `readlink(/proc/self/fd/<dup>)` classify bind/nobind/nonpath/trunc/error, **always close dup**; any other errno → explicit unknown and abort that process.
5. Recheck starttime + FDSize (change either direction → `identity_drift` / `pidfd_fdsize_changed`).
6. **Scan B:** identical probe of the same `[0, FDSize)`; occupied evidence (FD number + classification) must **agree exactly** with scan A or → `pidfd_scan_disagreement`.
7. Post recheck starttime + FDSize; commit agreed `FD_CLS_BIND` as matches; classification errors as unknowns.

**Not used:** `CAP_DAC_READ_SEARCH`, process-name carve-outs, soft/hard `RLIMIT_NOFILE` as probe ceiling, global `nr_open` as primary probe range.

**TEST_ONLY seams (absent from hardened binary):**

| Env | Role |
|---|---|
| `PAH_TEST_FORCE_PIDFD_FD_SCAN=1` | force pidfd path even when readdir would work (parent/child regressions) |
| `PAH_TEST_SPAWN_HIGH_FD=<n>` | helper forks a child that `dup2`s the target to FD `n` (contract **5000**), lowers soft `RLIMIT_NOFILE` below `n`, requires kernel FDSize `≥ n+1` |
| `PAH_TEST_FDSIZE=<n>` | override parsed FDSize (bounded/forced tests) |
| `PAH_TEST_FDSIZE_MALFORMED=1` | force `pidfd_fdsize_malformed` |
| `PAH_TEST_FDSIZE_CHANGE=1` | force non-stable FDSize across pre/mid/post → `pidfd_fdsize_changed` |
| `PAH_TEST_FDSIZE_TOO_LARGE=1` | force `pidfd_fdsize_too_large` (above SAFE_MAX) |
| `PAH_TEST_NR_OPEN=<n>` | override **validation** ceiling only (not primary probe bound) |

**Host facts (R5):**

| Fact | Value |
|---|---|
| `fs.nr_open` | `2147483584` (validation-only; no longer refuses the fallback by itself) |
| `(sd-pam)` FDSize | `128` (observed); opendir `EACCES` → pidfd path |
| high-FD=5000 child FDSize | `8192` after `dup2` (kernel table expansion) |
| Yama `ptrace_scope` | `1` |
| `pidfd_getfd` without CAP_SYS_PTRACE | works for parent→dumpable child; `EPERM` for non-descendant / non-dumpable `(sd-pam)` |
| Real capped residual | **still pending** — R5 worker performed **no setcap**; production remains BLOCKED for swap/restore residual |

**Performance (TEST_ONLY forced two-scan + high-FD=5000 child, this host):**

| Probe | Wall ms (representative) | high FD=5000 found |
|---|---|---|
| real FDSize=8192 × two scans (child) + ambient EPERM aborts | ~110 | yes |

Full host `nr_open` is **not** probed. Production only enters the fallback on `EACCES`/`EPERM` fd dirs; typical `(sd-pam)` FDSize=128 is cheap.

## Experiment 1 — without capability, no intended binding

```bash
TARGET=$(mktemp -d -p /tmp tachyon-368-audit-target-XXXXXX)
"$BUILDDIR/process-audit-helper" "$TARGET"; echo exit=$?
```

Observed (representative):

```text
state=unknown
self_ruid=1000
target=/tmp/tachyon-368-audit-target-…
cap_sys_ptrace=no
match_count=0
unknown_count=…
unknown reason=eaccess pid=… kind=cwd
…
exit=2
```

**No `empty` result** without capability. Path-leak check: no absolute paths in stdout other than the supplied `target=`.

## Experiment 2 — without capability, live open-FD binding

Disposable writer (cwd `/`, open FD to `$TARGET/writer.log`) still surfaces as `match kind=fd` while overall state remains **`unknown`** due to ambient same-UID `EACCES`. The helper’s own O_PATH pin is not counted as a match.

## Experiment 3 — F1 symlink target rejection

Symlink aliases that are not already the byte-exact resolved path are **refused** before scan (`error=target_not_canonical`, exit 3).

## Experiment 4 — H1 deterministic post_pin rename/replacement (TEST_ONLY)

```text
PAH_TEST_SEAM_DIR=… PAH_TEST_SEAM_PHASE=post_pin ./process-audit-helper-test $TARGET
# parent waits for post_pin.ready, rename+mkdir replacement, touch post_pin.release
→ state=unknown
→ unknown reason=target_identity_drift
→ exit=2
```

Barrier **must** be reached; ambient `eaccess` alone is not accepted as proof.

## Experiment 5 — H2 hold drift across observation (TEST_ONLY)

```text
PAH_TEST_SEAM_PHASE=obs … 
# parent waits for obs.ready, rename+mkdir held across observation, release
→ state=unknown
→ unknown reason=target_identity_drift (or other target_*)
→ exit=2
```

## Experiment 6 — swap/restore characterization (TEST_ONLY)

At `obs.ready`, rename target away then restore the **same inode** before release. Post-barrier revalidate can see a restored path and continue; host still ends `unknown` from ambient `EACCES`, not a complete `empty`. This characterizes the **malicious same-UID move+restore residual** between separate procfs syscalls — still **not** closed by this primitive. **BLOCK production proven_empty / adapter rollout.**

## Experiment 7 — file capability install (noninteractive only)

```bash
sudo -n true
# => exit 1; stderr: sudo: interactive authentication is required

sudo -n /usr/sbin/setcap cap_sys_ptrace=ep "$BUILDDIR/process-audit-helper"
# => exit 1; same interactive authentication failure

/usr/sbin/setcap cap_sys_ptrace=ep "$BUILDDIR/process-audit-helper"
# => exit 1; unable to set CAP_SETFCAP effective capability: Operation not permitted

getcap "$BUILDDIR/process-audit-helper"
# => no capabilities
```

No password was solicited, captured, cached, or bypassed. **Capability-enabled scan was not executed.** Feasibility of a complete `empty`/`survivors` result under `CAP_SYS_PTRACE` on this host is therefore **not demonstrated**.

### One minimal human residual (not run in R5)

After rebuilding the **hardened** binary and verifying SHA-256 `856b0b78aecca1540a2eaee701032e9df436e709e100b0ea3f3944f542a36185`, a human with credentials could install `cap_sys_ptrace=ep` on that exact binary (on a non-`nosuid` filesystem) for a privileged recheck of whether `pidfd_getfd` over FDSize-bounded probes closes the `(sd-pam)` residual (FDSize=128). That capped empirical run is **required** before any host-complete claim. It is **out of band**, was **not** performed in this R5 worker round, and still does **not** erase the irreducible move+restore residual or authorize production rollout.

## Experiment 8 — R5 high-FD=5000 above lowered soft limit (TEST_ONLY)

```bash
PAH_TEST_FORCE_PIDFD_FD_SCAN=1 PAH_TEST_SPAWN_HIGH_FD=5000 \
  ./process-audit-helper-test "$TARGET"
# → match kind=fd fd=5000 for the helper-spawned child
# → kernel FDSize expanded to 8192 (≥ 5001) after dup2
# → soft RLIMIT_NOFILE lowered to 2500 (= high/2); soft-bound [0, soft) would MISS 5000
# → ambient non-child pidfd attempts → pidfd_getfd_eperm (explicit unknown)
# → child reaped; /tmp/pah-test-soft-<pid> and /tmp/pah-test-fdsize-<pid> removed
# → wall ~110ms for two-scan over FDSize=8192 (not host nr_open)
```

**Proves:** FDSize-bounded pidfd path finds FDs that a soft-`RLIMIT_NOFILE` completeness bound would miss, and does so beyond the lowered soft without using global `nr_open` as the probe range.

## Experiment 9 — R5 FDSize seams (TEST_ONLY)

```bash
PAH_TEST_FORCE_PIDFD_FD_SCAN=1 PAH_TEST_FDSIZE_MALFORMED=1 … → pidfd_fdsize_malformed; state=unknown
PAH_TEST_FORCE_PIDFD_FD_SCAN=1 PAH_TEST_FDSIZE_CHANGE=1    … → pidfd_fdsize_changed; state=unknown
PAH_TEST_FORCE_PIDFD_FD_SCAN=1 PAH_TEST_FDSIZE_TOO_LARGE=1 … → pidfd_fdsize_too_large; state=unknown
```

All three refuse closed (never `empty`).

## Experiment 10 — production EACCES fd-dir → FDSize-bounded pidfd (this host, no cap)

Without capability, PID 1533 `(sd-pam)` still yields cwd/root `eaccess`; fd-directory `EACCES` routes through the R5 pidfd fallback (FDSize=128) and reports `pidfd_getfd_eperm` on the first probe (Yama / non-dumpable / non-descendant). State remains **`unknown`** (never `empty`). The R4 `pidfd_nr_open_too_large` refuse from host `fs.nr_open=2147483584` is **gone** — bound is per-process FDSize.
## Security analysis

| Topic | Analysis |
|---|---|
| Privilege model | Intended privilege is **file capability** `CAP_SYS_PTRACE` only (ep), not setuid-root. |
| Least privilege | Helper is read-only: `readlink`/`open`/`read` on `/proc` plus `O_PATH` on the target, no `ptrace(PTRACE_ATTACH)`, no signals, no procfs writes, no target mutation. |
| Output surface | Does not print foreign path strings — only state, counts, match pid/starttime/kind/fd, and bounded unknown reason codes. |
| Domain limit | Real-UID filter: other users’ processes are skipped silently. |
| Target canonicality (F1) | Independent `realpath` + byte-exact match + `O_PATH` pin + every-pass pre/post revalidation. |
| Per-observation drift (H2 practical) | Live `/proc/self/fd` path + pre/post revalidate around each link observation; held rename → `target_*` unknown. |
| Irreducible residual | Malicious same-UID **move+restore between separate procfs syscalls** cannot be mathematically excluded by this readlink primitive. |
| Identity races (pid) | Starttime pin + recheck around each pid scan; drift → `identity_drift` unknown. |
| Truncation | `readlink` buffer fill → `truncation` unknown. PID enum overflow → `pid_enum_truncated` unknown. |
| Capability loss (F2) | Sticky `capability_loss` re-counted/reported every pass through final output. |
| TEST_ONLY seam | Present only in `-DTEST_ONLY` builds; hardened binary strings contain no `PAH_TEST_SEAM_DIR`; no environment-controlled pause in the privileged candidate. |
| Attack surface if cap installed | Broader same-UID `/proc` read — sensitive; binary must be tightly owned, checksum-verified before setcap. |
| What this does **not** prove | Production adapter correctness, atomic binding observation under a coordinating attacker, or that `CAP_SYS_PTRACE` is the final architecture choice. |
| Relation to cgroup spike | Cgroup containment can prove membership empty; this audit is the **independent** worktree-binding clause. Neither alone is full `proven_empty`. |

## Cleanup proof

After experiments:

```bash
rm -rf /tmp/tachyon-368-audit-build-* /tmp/tachyon-368-audit-target-*
find /tmp -maxdepth 1 -name 'tachyon-368-audit*' -print
# no output — CLEAN
```

No file capabilities were successfully installed, so no `setcap -r` was required. No system config was modified. No production tree paths outside owned spike files and the generated gate test were changed.

## Residuals

| Residual | Severity | Notes |
|---|---|---|
| Interactive credentials required for `setcap` | **Blocks feasibility claim** | Noninteractive setcap unavailable on this host |
| Capability-enabled complete scan not observed in R5 | Blocks PASS | Prior capped run (R3 binary) reduced residual; R5 binary not re-capped here; capped `(sd-pam)` empirical still required |
| `(sd-pam)` without CAP_SYS_PTRACE | Host residual | FDSize=128 fallback reaches `pidfd_getfd_eperm` (not nr_open refuse) |
| Malicious same-UID move+restore between procfs syscalls | **Irreducible with this primitive** | Disclosed; **BLOCK production proven_empty / adapter** |
| Production ProcessFence adapter | Out of scope / blocked | Explicit non-goal; still unavailable |
| Cap + seccomp interaction under agent runtimes | Residual risk | Re-verify CapEff after exec of any capped binary |
| Independent re-review | Planned | Sonnet re-reviews R5; coordinator retains acceptance |

## Findings status

| Finding | Severity | Status |
|---|---|---|
| F1 target canonicality / TOCTOU | MEDIUM | **Closed** (R2) — realpath + O_PATH + pass revalidation |
| F2 sticky cap-loss reason transparency | LOW/MEDIUM | **Closed** (R2) — sticky re-emit every pass |
| H1 nondeterministic bare race / EACCES fallback | MEDIUM | **Closed** (R3) — TEST_ONLY seam; barrier required; forced `target_*` |
| H2 per-process swap/restore window | HIGH (practical) / residual | **Practical fail-closed** via per-observation checks; **fundamental residual remains** and is disclosed; production still **BLOCKED** |
| R4 soft-limit completeness (tradeoff B) | HIGH (correctness) | **Rejected** — do not use `RLIMIT_NOFILE` (`j-aec448bf6364`) |
| R4 `nr_open` as primary probe bound | HIGH (host incompleteness) | **Superseded by R5** — host `fs.nr_open` too large for SAFE_MAX; Sonnet R4 noted FDSize (`j-de678ede82c3`) |
| R5 FDSize-bounded `pidfd_getfd` fallback | — | **Implemented** under `j-de678ede82c3`; host still **BLOCKED** (no setcap / capped sd-pam empirical + move+restore residual) |

## What this does and does not authorize

**Does:**

- land a minimal, hardened, checksum-pinned **prototype** helper source under `.tachyon/studies`;
- close H1 test nondeterminism and practical per-observation drift handling under `j-df883330e9cf` without overclaiming the fundamental procfs race;
- implement R5 FDSize-bounded `pidfd_getfd` fallback under two-scan convergence (`j-de678ede82c3`), preserving R4 scaffolding and R1–R3 protections, with high-FD=5000 soft-bound-miss + FDSize expansion proof and malformed/change/oversize seams;
- document that without capability the host still fails closed at `unknown` for the global same-UID audit;
- keep the malicious same-UID swap/restore residual explicit.

**Does not:**

- claim CAP_SYS_PTRACE audit feasibility (BLOCKED);
- claim production `proven_empty` or default ProcessFence adapter readiness (BLOCKED);
- install a durable privileged binary or `CAP_DAC_READ_SEARCH`;
- implement or enable a production `ProcessFencePort` adapter;
- erase the irreducible multi-syscall move+restore residual;
- claim host-complete FD enumeration without a capped empirical `(sd-pam)` run on this R5 binary.

## Reproducible no-cap assertion (always)

```text
1. hardened build of pinned source succeeds; strings have no PAH_TEST_* seams
2. without cap: state=unknown exit=2 on empty disposable target
3. EACCES / pidfd_* unknowns include systemd / (sd-pam) class; sd-pam fd → FDSize-bounded pidfd → pidfd_getfd_eperm without cap
4. open-FD writer to target appears as match kind=fd while state remains unknown
5. symlink target path refused (exit 3 error=target_not_canonical)
6. TEST_ONLY post_pin barrier + forced rename → specific target_* (no EACCES fallback)
7. TEST_ONLY obs barrier + held rename → specific target_*
8. swap/restore characterization keeps residual disclosed; no empty claim
9. TEST_ONLY high-FD=5000 after soft-limit lowering found via FDSize-bounded pidfd; soft-bound would miss; FDSize≥5001
10. TEST_ONLY FDSize malformed/change/too-large seams → explicit unknown (never empty)
11. noninteractive setcap unavailable => BLOCKED feasibility; no setcap performed in R5
12. /tmp tachyon-368-audit-* build/target trees and pah-test-soft-*/pah-test-fdsize-* removed
```
