# SDD 368 T14.6A Linux systemd/cgroup ProcessFence adapter — Sonnet R1 independent review — FINDINGS

Reviewed immutable candidate `a9e058b4` (branch `tachyon/linuxProcessFenceGrokR1`) against journal contract
`j-a8882b27abab`, the T14.6A core adapter contract (`j-...` in the task journal), and the ratified production
threat model in `docs/specs/368-delivery-worktree-leases/notes.md` ("ProcessFence host-feasibility closure and
threat-model ratification"). Read all three changed files in full: `src/agents/linuxProcessFence.ts` (835 lines,
new), `test/unit/linuxProcessFence.test.ts` (796 lines, new), and the generated behavior test. Canonical
`verify_task` ACCEPT, no waiver, `npm run verify:full:quiet` green. Ran the existing 35-test suite myself: all
pass — but, as detailed below, several of the confirmed findings are gaps the current suite does not exercise at
all, not places where a passing test masks a real bug.

All seven coordinator hypotheses are **confirmed**, with severity and exact mechanism below.

## H1 — CONFIRMED (MEDIUM): `prepareLaunch` on a confirmed identity returns a fresh, re-executable launch wrapper; pending replay silently rewrites the persisted helper identity

`prepareLaunch` (`linuxProcessFence.ts:349-396`):

```
if (existing) {
  if (existing.unitName !== unitName || existing.bootId !== bootId) throw ...;
  if (existing.phase === "confirmed") {
    return { command: wrapSystemdScopeCommand(unitName, cmd), unitName, nonceDigest: digest };
  }
}
const pending: FenceIdentityV1 = { ...phase: "pending", helperPath: inspection.path, helperSha256: inspection.sha256 };
await this.store.store(pending);
return {...};
```

Two distinct issues, both real:

1. **Confirmed-identity replay returns a re-launchable command.** The comment calls this "idempotent," but it
   isn't in the sense that matters: it hands back a byte-identical `systemd-run --unit=<same deterministic name>`
   wrapper that, if the caller actually executes it (a caller retry/bug — nothing in this diff prevents that), would
   attempt to create a **second** transient unit under a name systemd may already consider live. The function should
   refuse (a caller asking to launch an already-confirmed nonce again is itself the bug to surface), not silently
   re-mint a runnable command.
2. **Pending replay silently overwrites the persisted helper identity.** When `existing.phase === "pending"`, the
   code falls through to an **unconditional** `store.store(pending)` using whatever `this.requireHelperIdentity()`
   reports *right now* — with no comparison to the previously-stored `helperSha256`. A retried `prepareLaunch` call
   during the pending window silently re-pins to a different helper hash if the on-disk binary changed between the
   two calls, with no error, no signal — defeating the purpose of checksum-pinning at exactly the moment (during the
   pending→confirmed window) it matters most.

Neither issue silently produces a false `proven_empty` on its own (the identity-drift checks elsewhere provide a
downstream safety net — see H5 for where that net has a hole), but both violate the contract's "persist **one**
nonce-bound fence identity" invariant at the API-contract level.

## H2 — CONFIRMED (MEDIUM/HIGH): `FenceIdentityStore.store` has no create/CAS semantics; concurrent prepare/confirm can overwrite silently

`store(identity: FenceIdentityV1): Promise<void>` (`linuxProcessFence.ts:112-116`) is documented only as "atomic
replace" — no expected-previous-phase or version token parameter. Every call site (`prepareLaunch`'s pending write,
`confirmLaunch`'s confirmed write, `tryRepairPending`'s pending write) calls it unconditionally. Two concurrent
`prepareLaunch` calls for the same nonce (a caller bug, or two racing retries) both read `existing`, both compute
the same deterministic `unitName`, and both `store()` — last write wins, with zero detection. This is a real
regression in rigor relative to the rest of this SDD, which has built SQLite-transaction/CAS-guarded stores for
every other Delivery-lease primitive (T1, T9, T15) specifically to close exactly this class of race. A store
interface without at least an expected-phase/version guard cannot itself enforce "one nonce-bound identity" — it
depends entirely on caller discipline not visible in this diff.

## H3 — CONFIRMED (HIGH): no configured expected helper hash; only format validation. Group-writable helper is not rejected.

`requireHelperIdentity()` (`linuxProcessFence.ts:617-641`) and `probeCapability()` (`linuxProcessFence.ts:785-819`)
both validate the helper's *self-reported* SHA-256 only against `/^[0-9a-f]{64}$/` — a **format** check, not an
**identity** check. `LinuxProcessFenceDeps` (`linuxProcessFence.ts:123-135`) has no `expectedHelperSha256` field
anywhere. This means **any** 64-hex string the `AuditHelperPort.inspect()` implementation reports — including one
produced by a tampered, swapped, or entirely unrelated binary — satisfies every check in this module. The ratified
threat model names two specific accepted hashes (`e60d1cc8...` source / `856b0b78...` binary) after five rounds of
adversarial review specifically to pin against; this adapter never compares against them or any configured
reference value. This defeats the entire point of "checksum-pinned helper" as used throughout the contract text.

Separately: `isWorldWritable()` (`linuxProcessFence.ts:294-296`) checks only `mode & 0o002` (the *other*-write bit).
It does not check `mode & 0o020` (the *group*-write bit). A helper at mode `0o100775` (group-writable) passes every
check in this module. The prior spike reports' own guidance was mode `0700`/`0755` — neither of which is
group-writable — so a proper check should reject group-write too, not just other-write.

## H4 — CONFIRMED (HIGH, first half); dead code confirmed but not currently exploitable (second half)

**`confirmLaunch` can persist a `"confirmed"` identity with zero cgroup members.** `linuxProcessFence.ts:443-454`:

```
const procs = await this.cgroup.readProcs(snap.controlGroup);
if (procs === "missing") { throw ...; }
const confirmed: FenceIdentityV1 = { ...identity, phase: "confirmed", invocationId: snap.invocationId, controlGroup: snap.controlGroup };
await this.store.store(confirmed);
```

Only `procs === "missing"` (the cgroup path itself absent) is rejected. `procs.length === 0` (cgroup exists, is
readable, but is genuinely empty — e.g. the launched command crashed instantly, or the process hadn't yet been
placed into the scope) is **never checked**, despite the contract's explicit "confirm the unit identity **and
membership** before confirming the Delivery reservation as held." A Delivery could be marked held under a fence
identity with nothing actually running underneath it — a phantom hold that blocks legitimate reuse while nothing
exists to eventually complete or be fenced. I confirmed via the test file that **no test exercises this path**:
every `confirmLaunch`/`launchAndConfirm` helper in the test suite seeds `procs: [non-empty]`.

**Dead conditional branch, confirmed but not currently exploitable.** `confirmLaunch`'s poll probe
(`linuxProcessFence.ts:428-437`):

```
if (s.id && s.id !== unitName && s.id !== unitName.replace(/\.scope$/, "")) {
  // Accept unit id with or without .scope suffix conventions; require exact name match when present.
}
```

This condition, when true, does **nothing** — no throw, no `return null` — directly contradicting its own comment.
However, I traced the actual consequence: a **separate**, stricter check immediately after `pollUntil` returns
(`if (snap.id && snap.id !== unitName) throw ...`, `linuxProcessFence.ts:439-441`) independently enforces exact-name
matching and does catch a wrong-`id` snapshot before it can be accepted — confirmed by the existing "detects unit id
collision" test, which passes. So this dead branch is real dead code with a misleading comment (worth deleting or
implementing as commented), not a live soundness gap in the confirm path itself — though see H7 for the *repair*
path, which lacks even this redundant outer check.

## H5 — CONFIRMED (HIGH): `terminate`'s bounded `systemctl stop` cleanup can act on a same-named, unrelated unit if the pinned name is reused mid-poll

`terminate()`'s retry loop (`linuxProcessFence.ts:485-511`) checks invocation drift only as:

```
if (live.invocationId && identity.invocationId && live.invocationId !== identity.invocationId) {
  throw new ProcessFenceError("PROCESS_FENCE_IDENTITY", "invocation drift during terminate");
}
```

Both sides must be truthy for this to fire. If a **new**, unrelated unit happens to be live under the exact same
deterministic name (e.g. because `--collect` garbage-collected the original after it died, and something — see H1's
duplicate-relaunch finding for one concrete mechanism — created a fresh unit under the same name) and that new
unit's `invocationId` is empty/not-yet-populated (a plausible transient state for a just-started unit), this check
is silently skipped entirely. Worse, `identity.controlGroup` (the *pinned* value, captured once at function entry as
`cg`) is used directly for every `readEvents`/`writeKill` call in the loop and is **never re-compared** against
`live.controlGroup` inside the loop — only the one-time `assertExactLiveIdentity` call at the very top of `terminate`
checks ControlGroup, and that was before the poll loop (and thus before the possible mid-poll unit-name reuse) even
started. If that (now-foreign) unit's cgroup happens to read `populated: 0` and its `activeState` is still
active/running, the code proceeds to `systemd.stop(unitName)` — which, since `unitName` is the shared deterministic
name, stops the **wrong, unrelated unit**. This directly contradicts the code's own comment ("Bounded cleanup only
for the same exact unit") and the contract's explicit requirement. I confirmed the existing "never stops a unit
that is not the pinned identity" and "terminate kills only the pinned unit" tests exercise a **different, trivially
safe** scenario (a *differently-named* foreign unit, which obviously can't be touched by a name-based lookup) — not
this same-name-reuse race. No test covers it.

## H6 — CONFIRMED (MEDIUM/HIGH, multiple sub-issues): parser under-validates helper output; a self-contradictory `survivors`-with-zero-matches result is silently accepted

`parseAuditHelperStdout` (`linuxProcessFence.ts:221-287`) and the `exitCode === 1` branch of `proveEmpty`
(`linuxProcessFence.ts:581-593`):

1. **`target=` is read but never compared** to the `canonicalWorktree` argument actually passed to `auditHelper.run`.
   A helper (or a buggy port implementation) that echoes the wrong target would be silently trusted.
2. **`self_ruid=` is read but never validated** against an expected UID.
3. **`stderr` is captured in `AuditHelperRunResult` but never inspected anywhere** in `proveEmpty` — any diagnostic
   or error text on stderr alongside a well-formed stdout is ignored entirely.
4. **Confirmed, concrete bug**: for `exitCode === 1`, the only guards are `parsed.state !== "survivors"` and
   `parsed.unknownCount !== 0`; there is no requirement that `parsed.matchCount > 0`. A helper output reporting
   `state=survivors`, `unknown_count=0`, `match_count=0` (a combination the C helper's own state-precedence logic
   can never legitimately produce, since `ST_SURVIVORS` requires `match_count > 0`) passes every check and returns
   `{ state: "survivors", pids: [] }` — a self-contradictory result (claims survivors, lists none) that should be
   `unknown`. I confirmed via the test file that **no test exercises `matchCount === 0` with `state === "survivors"`**
   — the only survivors fixture uses two real pids.
5. Numeric parsing (`Number(v)` after only an all-digits regex check) never validates `Number.isSafeInteger`,
   so an absurdly long digit string silently becomes `Infinity` rather than being rejected as malformed. Comparisons
   downstream happen not to break in an exploitable way that I could find, but this is a real missing-bounds-check
   gap in a parser handling untrusted subprocess output.
6. Truncation markers (`match_truncated=`/`unknown_truncated=`) are read-and-ignored rather than cross-validated
   against the count/list-length relationship — lower severity than the above since the underlying numeric counts
   are what `proveEmpty`'s consistency checks actually gate on, and I traced that legitimate truncation cannot
   coexist with the zero-counts required for `proven_empty`; still, an under-populated-but-nonzero `matchPids` list
   with **no** truncation marker at all is accepted without complaint, which a defensive parser should flag.

## H7 — CONFIRMED (MEDIUM): identity schema version is never checked on load; `tryRepairPending` lacks the unit-id cross-check the primary confirm path has

`identity.schemaVersion` is defined and stamped on write but **never checked against `FENCE_IDENTITY_SCHEMA_VERSION`
after `store.load()`** anywhere in `LinuxSystemdProcessFence` — a future schema migration or a corrupted record
with a different version would be trusted blindly rather than rejected.

More concretely, `tryRepairPending` (`linuxProcessFence.ts:683-711`) — the path explicitly reserved by the contract
for "repair... only from the unique deterministic live unit whose current boot/unit identity is exact" — queries
`this.systemd.show(unitName)` and checks `loadState`/`invocationId`/`controlGroup`/`activeState`, but **never checks
`snap.id === unitName`** the way the primary `confirmLaunch` poll does (redundantly, per H4). The repair path is
therefore *less* rigorous than the path it's meant to be a fallback for — exactly the kind of provenance gap H7
flags, and worth closing by reusing the same exact-id assertion both paths should share.

## Verdict

**FINDINGS.** All seven coordinator hypotheses are confirmed as real, with H3 (no expected-hash pin), H4 (confirm
without membership), H5 (terminate can act on a reused unit name), and H6 (self-contradictory survivors accepted)
the most severe — each is a genuine gap between what the ratified threat model requires and what this candidate
enforces, not a matter of interpretation. None currently produces a demonstrated *silent* `proven_empty` false
positive on its own (the identity-drift and cgroup-membership checks elsewhere provide partial defense-in-depth),
but several compose (H1's duplicate-relaunch mechanism is a plausible trigger for H5's same-name-reuse race) into
scenarios the current 35-test suite — passing and generally well-constructed for the paths it does cover — does not
exercise. Recommend closing H3/H4/H5/H6 before this candidate is treated as ready for the opt-in production rollout
gate; H1/H2/H7 should also be closed given how much rigor the rest of this SDD has invested in exactly these
classes of gap (atomic/CAS stores, exact-identity provenance) elsewhere.
