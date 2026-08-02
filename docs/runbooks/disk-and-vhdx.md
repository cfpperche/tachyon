# Runbook — freeing disk in WSL, and why Windows still shows the same VHDX

_Written 2026-08-02 for `t-3374e2` (SDD 398 D7), from the measurement in `t-2a2af8` (notes
`j-651b6df71d9d`, `j-fe59df75753e`)._

## The one sentence this runbook exists for

**Deleting files inside WSL and shrinking the disk file on Windows are two different operations, and
only the first one is Tachyon's.** Everything below is the consequence of that split.

## Two targets, never one number

| | Target A — inside WSL | Target B — the Windows host |
|---|---|---|
| What it is | free blocks in the distribution's ext4 filesystem | the size of `ext4.vhdx` on the NTFS volume |
| How you read it | `df -h /` in the distribution | the file's size in Explorer / `Get-Item` |
| What frees it | `rm`, `npm run disk:vscode-test -- reclaim --confirm`, `git worktree remove`, … | a host-side compact, with WSL shut down |
| Who does it | you, or a Tachyon command you typed | **you, on Windows.** Tachyon never does this |

WSL 2 stores each distribution in a Virtual Hard Disk formatted ext4 and represented on the Windows
side as an `ext4.vhdx` file; WSL 2 grows that file automatically to meet storage needs
([How to manage WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space)).

Growth is automatic. Shrinking is not, and Microsoft says so in the reference for the command that
does it — dynamically expanding VHDs increase in size as you add files, but
**"they do not automatically reduce in size when you delete files"**
([`compact vdisk`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)).

So a reclaim inside WSL returns blocks to ext4 — real, immediately reusable by anything running in
Linux — and leaves the `.vhdx` exactly as large as it was. That is not a bug and not a partial
failure. It is the storage model.

## What this means for the numbers Tachyon prints

Every byte figure produced by a Tachyon disk surface is a **Target A** figure, and it says so on the
line that prints it. `scripts/vscode-test-cache.ts` routes every reclaim total through one function
(`wslBytes`) whose output always reads `… in WSL (ext4)`, and
`test/unit/vscodeTestCacheReclaim.test.ts` fails if any line that claims freed bytes omits it.

If you add a surface that reports reclaimed bytes — a Cockpit row, a Bridge tool, a log line — it
carries the same qualifier. Reporting "freed 1.9 GB" without saying which disk is the specific error
this runbook was written to prevent: the human checks Windows, sees no change, and concludes the
product lied.

## The measured case, end to end

Measured 2026-08-02 on this host, allocated bytes (`du -s --block-size=1`, not apparent size — the
allocated count is what actually returns to ext4):

| Checkout | Payload | Bytes |
|---|---|---|
| `/home/goat/tachyon` (primary) | `.vscode-test/vscode-linux-x64-1.128.0` | 959,107,072 |
| `…/worktrees/b349073a/claude` (live agent worktree) | `.vscode-test/vscode-linux-x64-1.131.0` | 1,054,625,792 |

~1 GiB per checkout that runs the editor-host harness, because `@vscode/test-electron` resolves its
cache as `<cwd>/.vscode-test` and `@vscode/test-cli` gives no way to redirect it. `npm run
disk:vscode-test` inventories all checkouts, pools each version once into
`~/.cache/tachyon/vscode-test` with a symlink left behind, and only then offers to delete what is
superseded. Free space at the time of measurement: 905,188,892,672 bytes (843 GiB), i.e. no urgency —
which is why the tool prefers pooling to deleting and never runs itself.

Pooling does not weaken offline runs, and that is checked rather than assumed: `download()` in
`@vscode/test-electron` reuses a version when `<cachePath>/vscode-<platform>-<version>/is-complete`
exists, and `fallbackToLocalEntries` picks the highest version a `readdir` of the cache directory
returns. A symlink answers both exactly like a directory. Rehearsed end to end on a scratch repo with
three worktrees on 2026-08-02: 36,700,160 → 15,740,928 allocated bytes, and all three checkouts still
resolve `1.131.0` with `is-complete` visible through the link.

After that reclaim, `df` inside WSL shows the space back. The `.vhdx` on Windows does not move.

### When the plan says it can free nothing

It means something is holding the payload, and the report names it. On the first real run here the
answer was `pid 1385967 exe …/vscode-linux-x64-1.131.0/chrome_crashpad_handler` — a helper from a gate
run **two days and fifteen hours earlier**, long since reparented to `systemd --user`, still pinning
~1 GiB. The tool refuses on purpose: it cannot tell a stray helper from a suite that is three seconds
from resolving that path, and getting that wrong breaks a test run to save bytes nobody needs.

Deciding to end such a process is a human call, made after looking at it (`ps -o pid,ppid,etime,cmd -p
<pid>`). If it keeps happening, that is a leak in the gate's teardown and belongs in a task, not in a
wider deletion rule.

## Shrinking the VHDX (Target B) — a host procedure, done by a human

Tachyon **does not automate** any of this, deliberately. Every step runs on Windows, outside the
distribution Tachyon lives in; the first step terminates the VM Tachyon is running in, taking every
agent, tmux server and engine with it; and the compact itself requires the disk to be detached or
read-only, a state no process inside the guest can arrange for itself. A product that offered a
button for this would be offering to kill its own host.

Free the space inside Linux **first** — compacting only reclaims blocks the filesystem has already
released.

1. Stop everything. From PowerShell:

   ```powershell
   wsl --shutdown
   ```

   "Immediately terminates all running distributions and the WSL 2 lightweight utility virtual
   machine" ([Basic commands for WSL](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)).
   Save your work first; this is not graceful.

2. Find the `.vhdx`. From PowerShell, replacing `<distribution-name>`:

   ```powershell
   (Get-ChildItem -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Where-Object { $_.GetValue("DistributionName") -eq '<distribution-name>' }).GetValue("BasePath") + "\ext4.vhdx"
   ```

   ([How to manage WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space)).

3. Compact it, either way:

   **diskpart** (no Hyper-V required), in an elevated Command Prompt:

   ```cmd
   diskpart
   select vdisk file="<pathToVHD>"
   attach vdisk readonly
   compact vdisk
   detach vdisk
   exit
   ```

   `compact vdisk` "reduces the physical size of a dynamically expanding virtual hard disk (VHD)
   file", and "you can only use compact dynamically expanding VHDs that are detached or attached as
   read-only"
   ([`compact vdisk`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)).

   **Hyper-V PowerShell**, if the Hyper-V module is installed:

   ```powershell
   Optimize-VHD -Path "<pathToVHD>" -Mode Full
   ```

   "To use Optimize-VHD, the virtual hard disk must not be attached or must be attached in read-only
   mode", and `-Mode Full` "scans for zero blocks and reclaims unused blocks. (Allowable only if the
   virtual hard disk is mounted read-only.)"
   ([`Optimize-VHD`](https://learn.microsoft.com/en-us/powershell/module/hyper-v/optimize-vhd)).
   Microsoft also notes the operation "can succeed without reducing the file size, if no optimization
   is possible" — a compact that frees nothing is a normal outcome, not an error.

4. Start WSL again and re-measure **both** numbers: `df -h /` in the distribution, and the `.vhdx`
   size in Explorer. They answer different questions and will not agree.

Recent WSL releases also offer sparse VHDs, which return freed blocks to the host without a manual
compact. That is not documented on any of the pages cited above, so treat it as unverified until you
have read `wsl --help` on the host in front of you — and note it changes Target B's behaviour, never
this runbook's separation of the two targets.

## Why Tachyon has no automatic cleanup either

The workspace owner's decision, recorded 2026-07-18 and reaffirmed 2026-08-02: **"no GC mechanism for
now."** No boot-time deletion, no timer, no background reclaim. `npm run disk:vscode-test` reports by
default and refuses to delete anything without `--confirm` on the command line, and
`test/unit/vscodeTestCacheReclaim.test.ts` fails if that stops being true.

The reasoning is the cost asymmetry, and it still holds: there are 843 GiB free, so waiting costs
nothing, while a wrong deletion breaks offline test runs or forces a gigabyte redownload. See
`docs/specs/398-worktree-disk-sustainability/` for the plan this decision narrowed, and `t-2a2af8`'s
journal for which of its decisions expired and why.
