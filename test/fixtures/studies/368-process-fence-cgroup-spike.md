# SDD 368 — ProcessFence cgroup / systemd-user feasibility spike

Date: 2026-07-12  
Host: `DESKTOP-BGG95NA`, WSL2  
Investigator: `processFenceCgroupGrokR1`  
Scope: empirical cgroup / transient systemd-user containment only; no production/config/spec changes; no CAP_SYS_PTRACE helper  
Prior study: `.tachyon/studies/368-process-fence-spike.md` (T0.2; containment via PID namespace; cgroup left unproven)

## Verdict

**PASS.** On this host, an unprivileged disposable transient `systemd --user` scope provides a sound **cgroup membership boundary** for the adversarial detach/reparent case required by ProcessFence:

1. A double-forked `setsid` writer that reparents away from the pane-root analogue **remains in the unit cgroup**.
2. Writing `1` to the unit's `cgroup.freeze` freezes membership (`cgroup.events` → `frozen 1`) and **stops the writer's log growth**.
3. Writing `0` thaws (`frozen 0`) and **log growth resumes**.
4. Writing `1` to `cgroup.kill` kills the detached writer; **`populated 0` is observed** on the cgroup before teardown; the unit becomes `LoadState=not-found` / `ActiveState=inactive` with empty `ControlGroup`.
5. `systemctl --user stop <unit>` is an equivalent terminate path (`KillMode=control-group`) that also removes the detached writer and tears the unit down.
6. A same-UID self-migration write of the writer's PID into the parent `app.slice/cgroup.procs` failed with `EBUSY` (`Device or resource busy`); the writer stayed in the unit cgroup.

This is a **positive cgroup adapter feasibility result** for this host and the tested cases. It does **not** authorize relaxing `proven_empty`, shipping a production adapter, or treating cgroup empty alone as a complete ProcessFencePort proof. The independent same-UID worktree `cwd`/`root`/open-FD audit incompleteness documented in the prior study remains a residual blocker for full `proven_empty` on this host.

## Contract under test (cgroup step only)

SDD 368 requires a per-execution fence that:

1. retains all descendants after session detachment and reparenting;
2. can freeze and terminate the entire execution membership;
3. can prove membership empty (`populated=0` / unit teardown) after kill;
4. cleans up disposable units and temp paths;
5. fails closed when evidence is incomplete (no optimistic empty).

This spike tests only the **cgroup / systemd-user** primitive. It does not implement the production port, does not install any ptrace helper, and does not re-open the global worktree audit.

## Host facts (rechecked 2026-07-12)

| Fact | Value |
|---|---|
| Kernel | `Linux 6.6.114.1-microsoft-standard-WSL2` x86_64 |
| Distro | Ubuntu `26.04` (`resolute`) |
| Virt | `systemd-detect-virt` → `wsl` |
| UID | `1000:1000` (`goat`), no effective/permitted capabilities used |
| systemd --user | `running`; systemd `259 (259.5-0ubuntu3)` |
| cgroup | unified v2, `/sys/fs/cgroup` `cgroup2 rw,...,nsdelegate` |
| Controllers | `cpuset cpu io memory hugetlb pids rdma` |
| Yama | `ptrace_scope = 1` |
| Boot ID | `191ea586-54b5-4c88-b8f1-281a11bcd7b3` |
| Investigator cgroup | `.../app-tmux.slice/tmux-spawn-d25013e7-e42b-40af-8a0d-453333bd5e68.scope` |

No sudo, no system-level config edits, no production source/test/config mutation.

## Method

Bounded adversarial harness under `/tmp` only:

- Unique unit names: `tachyon-368-cgroup-<runid>.scope` (and secondary `…-pop-…`, `…-stop-…`, `…-del-…`, `…-esc-…`).
- Unique workdirs: `mktemp -d -p /tmp tachyon-368-cgroup-*`.
- Launch: `systemd-run --user --scope --unit=<name> --collect <harness>`.
- Writer: Python double-fork → `setsid()` → `chdir("/")` → open FD to worktree log → append/fsync loop.
- Signals and cgroup writes targeted **only** at PIDs/paths belonging to the created unit.
- Cleanup: `cgroup.kill` and/or `systemctl --user stop`, then `rm -rf` only own `/tmp/tachyon-368-cgroup-*` dirs; recheck no leftover units.

## Experiment 1 — membership retain + freeze + thaw + cgroup.kill

### Exact identities

| Role | Value |
|---|---|
| Unit | `tachyon-368-cgroup-cg17838735781115017.scope` |
| InvocationID | `9c2b4854407e4b2a9de807042fc4782c` |
| ControlGroup | `/user.slice/user-1000.slice/user@1000.service/app.slice/tachyon-368-cgroup-cg17838735781115017.scope` |
| FragmentPath | `/run/user/1000/systemd/transient/tachyon-368-cgroup-cg17838735781115017.scope` |
| Delegate | `no` |
| KillMode | `control-group` |
| Workdir | `/tmp/tachyon-368-cgroup-cg17838735781115017-ISqQvw` |
| Pane-root PID | `1115050` |
| Writer PID | `1115071` (own PGID/SID `1115071`, PPID reparented to host init path `Relay(1848)` after pane exit) |

Cgroup ownership (all `goat:goat`):

```text
drwxr-xr-x  …/tachyon-368-cgroup-cg17838735781115017.scope
-rw-r--r--  cgroup.procs
-rw-r--r--  cgroup.freeze
--w-------  cgroup.kill
-r--r--r--  cgroup.events
```

### Membership before / after detach

**Before pane exit** (`cgroup.procs`):

```text
1115050   # pane root
1115071   # writer
```

`cgroup.events`: `populated 1`, `frozen 0`.

Both processes reported the unit cgroup in `/proc/<pid>/cgroup`.

**After pane exit**:

```text
PANE_STILL_ALIVE=no
cgroup.procs:
1115071
writer_still_in_unit_cgroup=yes
writer_cgroup_after=0::…/tachyon-368-cgroup-cg17838735781115017.scope
```

`cgroup.events` still `populated 1`. Detach/reparent did **not** drop cgroup membership.

### Freeze evidence

Pre-freeze log grew: `LOG_SIZE 404 → 504` (`LOG_GREW_PRE_FREEZE=true`).

Command:

```bash
echo 1 > "$CG_PATH/cgroup.freeze"
```

Observed:

```text
cgroup.freeze = 1
cgroup.events: populated 1 / frozen 1
LOG_SIZE_FROZEN 504 → 504  (1.0s sample)
LOG_GREW_WHILE_FROZEN=false
```

Note: `/proc/1115071/status` still reported `State: S (sleeping)` while the cgroup freezer held the writer. Functional freeze evidence is the combination of `frozen 1` and **zero log growth**, not the `/proc` letter alone. On this WSL kernel the cgroup freezer is effective for stop-the-writer even when the task letter does not flip to a distinct frozen marker.

### Thaw evidence

```bash
echo 0 > "$CG_PATH/cgroup.freeze"
```

Observed:

```text
cgroup.freeze = 0
cgroup.events: populated 1 / frozen 0
LOG_SIZE_THAW 529 → 629
LOG_GREW_AFTER_THAW=true
```

Writer ticks resumed (`tick 23…25`).

### Kill + unit teardown

```bash
echo 1 > "$CG_PATH/cgroup.kill"
```

Observed:

```text
WRITER_AFTER_KILL=dead
CG_PATH_GONE_AFTER_KILL=yes   # cgroup directory removed after last member
LoadState=not-found
ActiveState=inactive
SubState=dead
ControlGroup=
```

`--collect` removed the transient unit once empty.

## Experiment 2 — explicit `populated 0` observation

Separate unit `tachyon-368-cgroup-pop-cgpop17838736061115989.scope`, writer PID `1115998`.

Sequence: freeze then `cgroup.kill`, poll `cgroup.events` immediately:

```text
POLL_1 events=[populated 0
frozen 1] procs=[readfail]
POPULATED_0_OBSERVED=yes at poll 1
WRITER_ALIVE=no
```

Then unit: `LoadState=not-found`, `ActiveState=inactive`, `ControlGroup=`.

So **`populated 0` is readable on this host** when sampled before the kernel/systemd removes the cgroup directory. A production adapter must treat a vanished cgroup with a previously pinned unit identity carefully (pin unit name + InvocationID + boot ID; do not invent empty from an unrelated missing path).

## Experiment 3 — `systemctl --user stop` terminate path

Unit `tachyon-368-cgroup-stop-cgpop17838736061115989.scope`, detached writer `1116051` alone in cgroup.

```bash
systemctl --user stop tachyon-368-cgroup-stop-cgpop17838736061115989.scope
```

Observed:

```text
STOP_WRITER_ALIVE=no
LoadState=not-found
ActiveState=inactive
SubState=dead
ControlGroup=
```

`KillMode=control-group` stops the entire membership, including the reparented writer. Suitable as a terminate path alongside direct `cgroup.kill`.

## Experiment 4 — Delegate and escape resistance

### Delegate=yes

Live unit created with `--property=Delegate=yes`:

```text
Delegate=yes
LoadState=loaded
ActiveState=active
```

Freeze/kill also worked with the default `Delegate=no` on Experiment 1 (user-owned cgroup files). `Delegate=yes` is available if a future adapter needs nested child cgroups under the unit; it is **not required** for the freeze/kill/populated path proven here.

### Self-migration escape

Detached writer attempted:

```python
open("/sys/fs/cgroup/.../app.slice/cgroup.procs","w").write(str(os.getpid()))
```

Result:

```text
write_fail:OSError:[Errno 16] Device or resource busy
writer_cgroup remained the unit scope
```

This is evidence against casual self-escape into the parent slice under the conditions tested. It is **not** a complete non-migratability proof against every privileged mover, external agent with write access to other cgroups, or future kernel/systemd policy changes. Production should re-check membership against the pinned ControlGroup path and treat unexpected migration as `unknown`/`survivors`, never as empty.

## What this does and does not prove

### Proved (this host, these runs)

| Requirement | Result |
|---|---|
| Create unique disposable transient user scope without sudo | Yes (`systemd-run --user --scope --collect`) |
| User-owned `cgroup.freeze` / `cgroup.kill` / `cgroup.events` | Yes (`goat:goat` writable freeze/kill) |
| Membership retains after detach + setsid + reparent | Yes |
| Freeze stops work (log growth) | Yes |
| Thaw restores work | Yes |
| Kill empties membership; `populated 0` observable | Yes |
| Unit teardown after empty | Yes (`not-found` / inactive) |
| `systemctl stop` kills detached members | Yes |
| Cleanup of own units/tmp paths | Yes (final recheck clean) |

### Not proved / residual blockers

1. **Independent canonical worktree audit** still incomplete on this host (prior study: same-UID `/proc` `EACCES` on `systemd`, `(sd-pam)`, `postgrest`, etc.). Cgroup empty ≠ `proven_empty` under the accepted SDD contract.
2. **Production races**: multithreaded fork during freeze fixed-point, PID reuse, unit name collision, boot-ID drift after reboot, supervisor crash mid-kill, nested child cgroups under Delegate, concurrent external `cgroup.procs` moves by other same-UID managers.
3. **No CAP_SYS_PTRACE helper** was built or authorized this round (explicit non-goal).
4. **No production ProcessFencePort adapter** was implemented; capability must remain unavailable until the full port (containment + independent audit) is certified.
5. **WSL-specific freezer `/proc` state letter** quirk: rely on `cgroup.events` + observable side-effect (log/stop), not solely on `/proc` State letter.

## Recommended adapter implications (advisory only)

If a Linux cgroup adapter is later built for this host class:

- Launch each Delivery execution under a unique transient user scope (`systemd-run --user --scope` or equivalent D-Bus StartTransientUnit), name keyed by execution nonce.
- Persist: unit name, InvocationID, boot ID, ControlGroup path, creation time, and preferably a pidfd to a supervisor/main process.
- `freeze`: write `cgroup.freeze=1`; confirm `frozen 1` and a fixed-point membership sample; fail → `unknown`.
- `terminate`: `cgroup.kill=1` and/or `systemctl --user stop`; wait for unit inactive / cgroup gone with pinned identity checks.
- Membership empty evidence: `populated 0` and/or empty `cgroup.procs` while the path still exists, **or** unit `not-found` only when the unit identity was previously pinned for this execution.
- `proveEmpty` must still combine containment absence with the independent worktree binding audit; never return `proven_empty` from cgroup empty alone while that audit can return `unknown`.

## Reproducible commands

Create and inspect a disposable scope (read then mutate only the created unit):

```bash
UNIT="tachyon-368-cgroup-demo-$(date +%s)"
WORKDIR=$(mktemp -d -p /tmp "tachyon-368-cgroup-${UNIT}-XXXXXX")
# harness: double-fork setsid writer with open FD to $WORKDIR/writer.log
systemd-run --user --scope --unit="$UNIT" --collect python3 "$WORKDIR/harness.py" "$WORKDIR"
systemctl --user show "${UNIT}.scope" -p Id,LoadState,ActiveState,ControlGroup,Delegate,KillMode,InvocationID
CG=/sys/fs/cgroup$(systemctl --user show "${UNIT}.scope" -p ControlGroup --value)
cat "$CG/cgroup.procs" "$CG/cgroup.events"
echo 1 > "$CG/cgroup.freeze"; cat "$CG/cgroup.events"   # frozen 1
echo 0 > "$CG/cgroup.freeze"; cat "$CG/cgroup.events"   # frozen 0
echo 1 > "$CG/cgroup.kill"                               # membership die
systemctl --user show "${UNIT}.scope" -p LoadState,ActiveState,ControlGroup
rm -rf "$WORKDIR"
```

Essential assertions used here:

```text
1. writer remains in unit cgroup after pane death + setsid + reparent
2. freeze => frozen 1 and writer log does not grow
3. thaw  => frozen 0 and writer log grows again
4. cgroup.kill => writer dead; populated 0 observed (or cgroup gone after empty)
5. unit LoadState=not-found / ActiveState=inactive after collect/stop
6. systemctl --user stop also kills detached writer
7. self-write to parent cgroup.procs fails (EBUSY) under tested conditions
8. no leftover tachyon-368-cgroup-* units or /tmp dirs
```

## Cleanup proof

After all experiments:

```text
find /tmp -maxdepth 1 -name 'tachyon-368-cgroup-*' -print   # no output
systemctl --user list-units --all --no-legend 'tachyon-368-cgroup*'  # no units
```

All created processes were killed only via their unit cgroup or `systemctl --user stop` on those units. No signals were sent to processes outside the created units. No system config was modified. Temp evidence copies under `/tmp/evidence-*-saved.txt` used while drafting this report were removed after incorporation.

## Residual blockers (for full ProcessFencePort)

| Blocker | Severity | Notes |
|---|---|---|
| Global same-UID worktree audit `EACCES` | Blocks `proven_empty` | Carry-over from prior spike; not resolved here |
| Production fixed-point / race hardening | Blocks adapter ship | Not in scope of this feasibility spike |
| CAP_SYS_PTRACE / alternate audit helper | Explicitly out of scope this round | Do not install yet |
| Adapter certification suite | Required before capability=available | Must fail closed on any incomplete evidence |

## Relation to prior study

T0.2 recommended a user+PID-namespace containment core and left cgroup as “promising, unproven” because mutation was forbidden. This spike **proves** the cgroup path on the same host class under authorized disposable mutation. Both mechanisms remain candidates; neither alone completes the independent worktree audit. Capability for sequential Delivery handoff must stay **unavailable** until a certified adapter satisfies containment **and** the audit clause without relaxing `proven_empty`.
