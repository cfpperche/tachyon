# SDD 368 T14.6A Linux ProcessFence adapter — Sonnet R4.1 (final micro-review) — ACCEPT

Reviewed the exact `d3fae18b..2b088ae0` diff (2 production lines, 2 test lines) against journal contract
`j-878e3d9d7e59` and my R4 report (`.tachyon/reviews/368-linux-process-fence-t146a-r4.md`, `793edd1f`), which
identified the sole blocker: the unknown-line grammar's `kind === "fd"` branch incorrectly also required `fd`,
rejecting a real, empirically-observed output shape (`kind=fd` with no `fd=`, e.g.
`unknown reason=pidfd_nr_open_too_large pid=1533 kind=fd`) that eleven call sites in the real C helper legitimately
produce. Canonical `verify_task` ACCEPT, no waiver, no full.

## The fix, verified precisely

```diff
- || (kind === "fd" && (pid === undefined || fd === undefined))
+ || (kind === "fd" && pid === undefined)
```

Exactly the narrow change my R4 report recommended: drops only the incorrect `fd === undefined` half of the
`kind === "fd"` constraint. All three other grammar rules stay intact and correct:

- `fd !== undefined && kind !== "fd"` → still rejects `fd=` appearing without `kind=fd`.
- `kind === "fd" && pid === undefined` → still correctly requires `pid` whenever `kind=fd` (every real `KIND_FD`
  `add_unknown` call site in the C helper is process-specific and always carries a `pid`).
- `(kind === "cwd" || kind === "root") && (pid === undefined || fd !== undefined)` → unchanged; `cwd`/`root` still
  require `pid` and still forbid `fd`.

## Independently reproduced, not just read

I wrote a temporary scratch test (removed before finishing this review; `git status` confirmed clean afterward)
covering exactly four cases:

1. The **exact** line I personally observed empirically against the real `(sd-pam)` process in an earlier round of
   this review chain — `unknown reason=pidfd_nr_open_too_large pid=1533 kind=fd` — now parses successfully
   (previously `null`). This is the specific regression from my R4 report; confirmed fixed.
2. `fd=` without `kind=fd` (on a `kind=cwd` line) — still correctly rejected.
3. `kind=fd` without `pid` — still correctly rejected (confirms the fix didn't over-correct in the other direction).
4. A **match** line with `fd=0` — still parses correctly (no regression on the R4 `isSafeNonnegative` fix for
   R3-H2, which this diff does not touch).

The candidate's own new test (`unknownFdWithoutFd = unknownFdZero.replace(" fd=0", "")`, asserting `not.toBeNull()`)
covers the identical structural shape with a synthetic reason string — the grammar check is reason-string-agnostic,
so this is an equally valid regression proof for the parser logic itself; my own test above additionally pins the
exact real-world reason string for extra confidence. I also re-ran the full existing suite fresh: 54/54 pass, and
`git diff --check d3fae18b..2b088ae0` is clean.

## Scope discipline

The diff touches only `parseAuditHelperStdout`'s unknown-line branch and its own test — no architecture, no other
grammar rule, no store/helper/identity/CAS logic, nothing from the already-accepted R1-R4 closures or the LOW
`t-108a79` hypothesis. Nothing to reopen.

## Verdict

**ACCEPT.** The exact blocker from my R4 report is closed correctly and minimally, verified both by reading the
one-line diff and by independently reproducing the fix against the precise line I had personally observed break
parsing. No new issue found in this narrow scope. T14.6A Sonnet review is complete.
