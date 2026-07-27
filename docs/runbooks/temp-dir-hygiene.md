# Runbook — `/tmp` fills up and `verify:full` dies with ENOSPC

_Written 2026-07-27 after the incident that produced `t-25a908`._

## The symptom, and why it misleads

`npm run verify:full:quiet` fails before running a single test:

```
Serialized Error: { errno: -28, code: 'ENOSPC', syscall: 'open',
                    path: '/tmp/tachyon-verify-full-XXXXXX/vitest-report.json' }
```

This is not a test failure and not a code failure — the machine is out of disk. It is worth naming
because the output appears in the same place a red suite would, and the first instinct is to go look
at the diff. Check `df -h /tmp` before anything else.

## Why it happens

`/tmp` is a **tmpfs** — RAM-backed, small (7.9 GB on the current host), and **shared by every agent on
the box**. The suite creates temp directories with `mkdtempSync`; until `t-25a908`, 22 test files never
removed theirs. Measured on 2026-07-27: **236,560** stray directories, 109,051 from a single fixture
(`deliveryLeaseService`'s `tachyon-lease-`, which leaked 179 per run). Each is tiny; the cost is the
count, since tmpfs also pays for the directory entries themselves.

The fix removes the source: `test/helpers/tempDir.ts` hands out directories that delete themselves when
the test file ends, and `test/unit/tempDirHygiene.test.ts` fails if a test file creates one without
cleaning up.

Measured before and after, on the same host: `deliveryLeaseService.test.ts` alone left **179**
directories per run and now leaves **0**; a full suite run leaves **zero** Tachyon-created temp
directories. The only entries a run still writes to the temp root are `node-compile-cache` (Node's own)
and `opencode` (that CLI's), neither of which is ours to reap.

## Checking for a regression

Counting `/tmp` before and after a run does **not** work on a shared box — other agents' suites run
concurrently and dominate the delta. Give the run its own temp root instead:

```bash
PRIV=/tmp/lp; rm -rf "$PRIV"; mkdir -p "$PRIV"
TMPDIR="$PRIV" npx vitest run
ls -A "$PRIV"          # expect only: node-compile-cache, opencode
```

Keep that path **short**. `TMPDIR` deep under `$HOME` overflows the 108-byte `sockaddr_un` limit and
four socket/tmux tests fail for reasons that have nothing to do with the change under test — which is
also why `makeSocketTemp` pins `/tmp` on Linux rather than honoring `TMPDIR`.

This is the way to catch a *partial* leak, which the hygiene test cannot see: a file that cleans up
some of its directories and not others still contains a cleanup call, so the static guard passes.
Three files were in exactly that state (`soul`, `soulProfileTransactions`, `auth`) and were found this
way, not by reading.

## Clearing it safely on a shared box

The hazard is that a directory created seconds ago may be **live state** for another agent's running
suite. So never sweep by prefix alone; always add an age bound that exceeds the longest run in flight.

```bash
df -h /tmp                                   # confirm the diagnosis first

# What is actually there, grouped by producer:
find /tmp -maxdepth 1 -type d -printf '%f\n' \
  | sed -E 's/[A-Za-z0-9_]{6,}$/<RAND>/' | sort | uniq -c | sort -rn | head

# Sweep only OUR prefixes, only what is older than any plausible in-flight run:
find /tmp -maxdepth 1 -user "$(id -un)" -type d \
     \( -name 'tachyon-*' -o -name '*-studio-adapter-*' \) -mmin +90 \
     -exec rm -rf {} +
```

Three constraints, each load-bearing:

- **`-user "$(id -un)"`** — never touch another user's files.
- **`-mmin +90`** — 90 minutes is comfortably longer than a full suite; anything newer may be live.
- **Named prefixes only** — `/tmp` also holds X locks, browser profiles and editor state that are not
  ours to reap.

Do **not** exclude `/tmp/tachyon-verify-full.lock`: it is the one file that must survive, because it is
how concurrent full-suite gates avoid trampling each other. The `-type d` filter already spares it.

## If you are an agent and the sweep is refused

A mass `rm -rf` under a shared `/tmp` is correctly treated as a dangerous action. Do not work around
it. Report the diagnosis (the `uniq -c` table above is the useful artifact) and ask the coordinator to
clear it or to authorize the bounded sweep.
