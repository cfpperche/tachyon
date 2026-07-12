# SDD 368 — CAP_SYS_PTRACE worktree-binding audit helper feasibility spike

Date: 2026-07-12  
Host: `DESKTOP-BGG95NA`, WSL2  
Investigator: `processAuditHelperGrokR1`  
Scope: prototype read-only same-UID worktree-binding audit helper under `.tachyon/studies` plus disposable `/tmp` build/install only; no production ProcessFence adapter; no production/tests/config changes except the generated gate test.  
Prior studies: `.tachyon/studies/368-process-fence-spike.md` (audit `EACCES` blocker), `.tachyon/studies/368-process-fence-cgroup-spike.md` (cgroup containment accepted independently).

## Verdict

**BLOCKED.** The helper prototype is implemented, hardened-compiled, checksum-pinned, and empirically shown to:

1. reproduce the accepted fail-closed result **`unknown`** without capability when same-UID `/proc` targets return `EACCES`;
2. still detect a live open-FD binding to a canonical target while remaining `unknown` because the scan is incomplete;
3. emit only machine-readable state + match pid/starttime/kind/fd evidence + bounded unknown reasons (no unrelated process path strings);
4. refuse to claim a complete no-hit (`empty`) scan on this host without capability.

However, installing the authorized **file capability** `CAP_SYS_PTRACE` requires interactive credentials on this host:

- `sudo -n true` → `sudo: interactive authentication is required` (exit 1)
- `sudo -n setcap cap_sys_ptrace=ep <binary>` → same failure
- unprivileged `setcap` → `unable to set CAP_SETFCAP effective capability: Operation not permitted`

Per the spike contract: **do not claim feasibility** of a complete privileged audit when capability install is not already noninteractive. The residual human step is one minimal command (below) against the pinned binary checksum. This is **not** a PASS and **not** authorization to ship a production ProcessFence adapter.

## Contract under test

Accepted ProcessFence independent-audit predicate (unchanged):

| Result | Meaning |
|---|---|
| `empty` | complete no-hit scan of the declared domain |
| `survivors` | one or more matching cwd/root/FD bindings and no incomplete evidence |
| `unknown` | any unreadable / unstable / truncated / malformed / identity-drift / capability-loss evidence |

Helper requirements exercised:

- scan only processes whose **real UID** equals the invoker’s real UID;
- accept one **canonical absolute** directory target;
- never signal, ptrace-attach, write procfs, mutate the target, or expose unrelated process paths;
- inspect `cwd`, `root`, and every FD via `readlink` only;
- strip a single trailing ` (deleted)` display suffix carefully;
- pin and recheck `/proc/<pid>/stat` starttime around the per-pid scan;
- rescan vanishing processes to a bounded fixed point (max 8 passes);
- stable machine-readable stdout; exit `0 empty | 1 survivors | 2 unknown | 3 error`;
- compile with hardening flags; record source and binary SHA-256;
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
| Source SHA-256 | `7184effe63b01350ccf4b78ac3b58358971bc4e177eaf5acdc0e0df32c82a5b3` |
| Binary SHA-256 (hardened build) | `ec388bda68d5e7959ea56797bcfa278955b85264106e5048ef414569fc80eba1` |
| Disposable build root | `/tmp/tachyon-368-audit-build-*` (removed after experiments) |
| Disposable targets | `/tmp/tachyon-368-audit-target-*` (removed after experiments) |

## Build (exact)

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
```

Observed:

```text
compile_ok
7184effe63b01350ccf4b78ac3b58358971bc4e177eaf5acdc0e0df32c82a5b3  .tachyon/studies/368-process-audit-helper.c
ec388bda68d5e7959ea56797bcfa278955b85264106e5048ef414569fc80eba1  .../process-audit-helper
ELF 64-bit LSB pie executable, x86-64, dynamically linked
readelf: FLAGS BIND_NOW; FLAGS_1 NOW PIE
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

Unknown reason codes used: `eaccess`, `truncation`, `malformed_link`, `read_error`, `status_unreadable`, `stat_unreadable`, `fd_dir_error`, `identity_drift`, `capability_loss`, `proc_unreadable`, `pid_enum_truncated`, `instability_fixed_point`.

Report lists are bounded (`match` ≤ 256, `unknown` ≤ 64) with `*_truncated=yes omitted=N` when capped; counts remain total. Unrelated process path strings are never printed (only the caller-supplied `target=`).

State precedence implemented (fail-closed):

1. any incomplete evidence → `unknown` (exit 2);
2. else any match → `survivors` (exit 1);
3. else → `empty` (exit 0).

Matches may still be listed under `unknown` so an operator can see detected bindings without treating the scan as complete.

## Experiment 1 — without capability, no intended binding

```bash
TARGET=$(mktemp -d -p /tmp tachyon-368-audit-target-XXXXXX)
"$BUILDDIR/process-audit-helper" "$TARGET"; echo exit=$?
```

Observed (representative final recheck):

```text
state=unknown
self_ruid=1000
target=/tmp/tachyon-368-audit-target-3lrmdQ
cap_sys_ptrace=no
match_count=0
unknown_count=164
unknown reason=eaccess pid=1530 kind=cwd
unknown reason=eaccess pid=1530 kind=root
unknown reason=eaccess pid=1530 kind=fd fd=0
...
unknown_truncated=yes omitted=100
exit=2
```

Distinct `EACCES` PIDs in the report: `1530`, `1533`, `1193083` — matching the prior spike’s `systemd` / `(sd-pam)` / `postgrest` incompleteness class. **No `empty` result** without capability. Path-leak check: no absolute paths in stdout other than the supplied `target=`.

## Experiment 2 — without capability, live open-FD binding

Disposable writer (cwd `/`, open FD to `$TARGET/writer.log`):

```bash
python3 -c 'import os,time; fd=os.open("'"$TARGET"'/writer.log",os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o644); os.write(fd,b"hello\n"); os.chdir("/"); print(os.getpid(),flush=True); time.sleep(3600)' &
"$BUILDDIR/process-audit-helper" "$TARGET"; echo exit=$?
```

Observed:

```text
state=unknown
cap_sys_ptrace=no
match_count=1
unknown_count=164
match pid=1284271 starttime=156905820 kind=fd fd=3
exit=2
```

Interpretation:

- Open-FD binding detection works without capability for readable same-UID processes (cwd-only audits would miss this writer).
- Overall state remains **`unknown`** because unrelated same-UID processes still return `EACCES`. Under the accepted predicate this is correct fail-closed behavior: a hit does not convert incomplete evidence into `survivors`/`empty`.

Writer was killed after the observation; no signals were sent to any process outside the disposable writer PID.

## Experiment 3 — file capability install (noninteractive only)

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

### One minimal human command (residual)

After rebuilding from the pinned source (verify binary SHA-256 `ec388bda68d5e7959ea56797bcfa278955b85264106e5048ef414569fc80eba1`):

```bash
sudo setcap cap_sys_ptrace=ep /tmp/process-audit-helper-368
```

Suggested full human sequence (not run by this agent):

```bash
gcc -O2 -pipe -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE -pie -Wl,-z,relro,-z,now \
  -o /tmp/process-audit-helper-368 .tachyon/studies/368-process-audit-helper.c
sha256sum /tmp/process-audit-helper-368
# expect: ec388bda68d5e7959ea56797bcfa278955b85264106e5048ef414569fc80eba1
sudo setcap cap_sys_ptrace=ep /tmp/process-audit-helper-368
/tmp/process-audit-helper-368 /absolute/canonical/target
# expect with cap: eaccess unknowns for 1530/1533/postgrest gone if CAP_SYS_PTRACE grants readability;
# then empty or survivors per true bindings only
sudo setcap -r /tmp/process-audit-helper-368
rm -f /tmp/process-audit-helper-368
```

## Security analysis

| Topic | Analysis |
|---|---|
| Privilege model | Intended privilege is **file capability** `CAP_SYS_PTRACE` only (ep), not setuid-root. Raises ptrace/proc readability for otherwise blocked same-UID nondumpable/Yama targets. |
| Least privilege | Helper is read-only: `readlink`/`open`/`read` on `/proc`, no `ptrace(PTRACE_ATTACH)`, no signals, no procfs writes, no target mutation. |
| Output surface | Does not print foreign path strings — only state, counts, match pid/starttime/kind/fd, and bounded unknown reason codes. Reduces accidental leakage of unrelated process filesystem layout. |
| Domain limit | Real-UID filter: other users’ processes are skipped silently (not reported as unknown). |
| Identity races | Starttime pin + recheck around each pid scan; drift → `identity_drift` unknown. Vanishing pids trigger bounded fixed-point rescan; exhaustion → `instability_fixed_point`. |
| Truncation | `readlink` buffer fill → `truncation` unknown (never treated as non-binding). PID enum overflow → `pid_enum_truncated` unknown. |
| Capability loss | If started with effective CAP_SYS_PTRACE and later lost mid-run, `capability_loss` → unknown. |
| Attack surface if cap installed | A compromised caller that can execute the capped binary gains broader same-UID `/proc` read (cwd/root/fd targets) — still not arbitrary cross-UID ptrace attach of all tasks without further privilege, but still sensitive. Binary must be mode `0700`/`0755` owned tightly, path-pinned, checksum-verified before setcap, and not world-writable. |
| What this does **not** prove | Production adapter correctness, multi-thread fork races against a live fence, containerized hidepid variants, nested user namespaces, or that `CAP_SYS_PTRACE` alone is the final architecture choice. Coordinator retains security architecture and acceptance. |
| Relation to cgroup spike | Cgroup containment can prove membership empty; this audit is the **independent** worktree-binding clause. Neither alone is full `proven_empty`. |

## Cleanup proof

After experiments:

```bash
rm -rf /tmp/tachyon-368-audit-build-* /tmp/tachyon-368-audit-target-*
find /tmp -maxdepth 1 -name 'tachyon-368-audit*' -print
# no output — CLEAN
find /tmp -maxdepth 2 -name 'process-audit-helper*' -print
# no leftover helper binaries
```

No file capabilities were successfully installed, so no `setcap -r` was required. No system config was modified. No production tree paths outside owned spike files and the generated gate test were changed.

## Residuals

| Residual | Severity | Notes |
|---|---|---|
| Interactive sudo required for `setcap` | **Blocks feasibility claim** | Human must run the one `sudo setcap …` command on a checksum-pinned binary |
| Capability-enabled complete scan not observed | Blocks PASS | Cannot assert `empty` is reachable under CAP_SYS_PTRACE on this host until that command is run and rechecked |
| Production ProcessFence adapter | Out of scope | Explicit non-goal; still unavailable |
| Cap + seccomp interaction under agent runtimes | Residual risk | Investigator shell has seccomp filters; production supervisor must re-verify effective CapEff after exec of the capped binary |
| Independent review | Planned | Sonnet (or successor) reviews; coordinator retains acceptance |

## What this does and does not authorize

**Does:**

- land a minimal, hardened, checksum-pinned **prototype** helper source under `.tachyon/studies`;
- document that without capability the host still fails closed at `unknown` for the global same-UID audit;
- document the exact human `setcap` residual.

**Does not:**

- claim CAP_SYS_PTRACE audit feasibility (BLOCKED);
- install a durable privileged binary;
- implement or enable a production `ProcessFencePort` adapter;
- relax `proven_empty` or sequential Delivery handoff.

## Reproducible no-cap assertion (always)

```text
1. hardened build of pinned source succeeds
2. without cap: state=unknown exit=2 on empty disposable target
3. EACCES unknowns include systemd / (sd-pam) / postgrest class PIDs
4. open-FD writer to target appears as match kind=fd while state remains unknown
5. no unrelated path strings in stdout
6. sudo -n setcap not available => BLOCKED feasibility; one human setcap command residual
7. /tmp tachyon-368-audit-* build/target trees removed
```
