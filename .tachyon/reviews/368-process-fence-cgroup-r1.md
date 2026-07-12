# SDD 368 ProcessFence cgroup/systemd-user spike — Sonnet R1 independent review — ACCEPT

Reviewed immutable candidate `68e7af82d7ccfba4114ddee2f697f87437ef834e` (report blob `bf0a0993`, branch
`tachyon/processFenceCgroupReportLunaR2`, worktree
`/home/goat/.cache/tachyon/worktrees/b349073a/processFenceCgroupReportLunaR2`) against the journal contract
`j-2aa9e656f2d3`. Read `.tachyon/studies/368-process-fence-cgroup-spike.md` (327 lines) in full and the prior
`.tachyon/studies/368-process-fence-spike.md` (T0.2, `PARTIAL`) it builds on. Confirmed canonical `verify_task`
ACCEPT with no waiver (`.tachyon/verifications/68e7af82d7ccfba4114ddee2f697f87437ef834e.json`), and that the
"canonical behavior" gate here is a shallow mechanical check —
`test/unit/processFenceCgroupReportLunaR2Behavior.gen.test.ts` only asserts the report file's text contains
`"PASS"`. This review is the actual semantic quality gate on the empirical claims.

## Provenance/integrity check (before content review)

Two prior candidates on the source branch (`tachyon/processFenceCgroupGrokR1`) were canonically blocked, both for
purely **mechanical** reasons unrelated to report content:
`ba2599c493b37b0b24d2d86ca5881b48fe302a4a` (`typecheck_failed`) and
`09151655546dd790790750e7181f372d3589a842` (`behavior_failed`: `test: extra argument '&&'`, a shell-syntax bug in
the generated stub script). I extracted `.tachyon/studies/368-process-fence-cgroup-spike.md` from the original
Grok commit `ba2599c4` and diffed it byte-for-byte against the final candidate `68e7af82`'s copy: **zero
differences**. Luna's migration to a fresh branch fixed only the generated-test packaging; the empirical report is
unmodified, single-authorship Grok content throughout. No integrity concern.

## Independent host-fact reverification (read-only)

I re-ran the report's own read-only host-fact commands directly, without any cgroup/systemd-unit mutation (staying
inside the "keep production/tests/report read-only" scope of this review):

```
uname -a            → Linux DESKTOP-BGG95NA 6.6.114.1-microsoft-standard-WSL2 x86_64   (matches)
distro               → Ubuntu 26.04 (resolute)                                          (matches)
id                    → uid=1000(goat) gid=1000(goat)                                   (matches)
systemd-detect-virt   → wsl                                                             (matches)
systemctl --user      → running                                                         (matches)
/sys/fs/cgroup        → cgroup2 rw,...,nsdelegate                                       (matches)
controllers           → cpuset cpu io memory hugetlb pids rdma                          (matches, exact set)
/proc/sys/.../yama/ptrace_scope → 1                                                     (matches)
own cgroup            → .../app-tmux.slice/tmux-spawn-<uuid>.scope                      (same shape as report's)
```

Every host-level fact the report claims is independently and exactly reproducible on this same machine. This is
strong corroborating evidence that the report reflects genuine commands run on this real host, not fabricated
output.

## Audit against the ten specified scrutiny points

1. **Transient unit identity/pinning.** Exact identities recorded per experiment (unit name, InvocationID,
   ControlGroup path, FragmentPath, Delegate, KillMode). The adapter-implications section explicitly requires
   persisting "unit name, InvocationID, boot ID, ControlGroup path, creation time... a pidfd to a supervisor" —
   correct and sufficient for future PID-reuse/identity-drift defense.
2. **Detached/reparented membership.** Experiment 1's before/after-detach table is concrete: writer stays in
   `cgroup.procs` after pane-root death, `populated 1` unchanged, PPID reparents to host init — directly satisfies
   the "retains descendants after detach/reparent" contract clause with real before/after evidence, not assertion.
3. **Freeze/thaw evidence.** Backed by a *behavioral* signal (log-growth stops/resumes), not merely the state flag
   — and the report proactively flags a real WSL quirk (`/proc` State letter stays `S` while frozen) rather than
   silently relying on a signal it observed to be unreliable on this kernel. This is exactly the kind of
   self-correcting rigor an adversarial reviewer looks for.
4. **`cgroup.kill` / `populated=0` interpretation, vanished-path ambiguity.** Experiment 2 exists specifically to
   capture `populated 0` by immediate poll *before* the cgroup directory disappears, and the report explicitly
   warns against treating an unrelated vanished path as empty: "pin unit name + InvocationID + boot ID; do not
   invent empty from an unrelated missing path." Experiment 1's kill evidence (cgroup gone + `LoadState=not-found`)
   is correctly treated as the *weaker*, ordinary-case signal, with Experiment 2 supplying the stronger direct
   observation — a deliberately complementary pair, not a gap.
5. **`systemctl stop` equivalence.** Experiment 3 is a distinct unit/writer pair testing `systemctl --user stop`
   specifically, confirming it also kills the reparented/detached writer via `KillMode=control-group` — a real,
   separate proof, not inferred from Experiment 1.
6. **Self-migration/escape claim limits.** Experiment 4 reports exactly one tested vector (self-write to the
   parent slice's `cgroup.procs`, `EBUSY`) and explicitly bounds the claim: "not a complete non-migratability proof
   against every privileged mover, external agent... or future kernel/systemd policy changes." No overclaiming.
7. **Cleanup truth.** Final recheck commands (`find /tmp ... tachyon-368-cgroup-*` → no output;
   `systemctl --user list-units ... tachyon-368-cgroup*` → no units) are shown, and the report states no signal
   was sent outside created units and no system config was touched — consistent with the diffstat showing zero
   production/config changes.
8. **WSL/kernel scope.** Every claim is host/host-class scoped ("this host", "this host class"); the WSL freezer
   `/proc`-letter quirk is called out by name as a residual item, not glossed over.
9. **PASS scope limited to containment feasibility, not full `proven_empty`.** Stated up front in the Verdict
   ("does **not** authorize relaxing `proven_empty`, shipping a production adapter, or treating cgroup empty alone
   as a complete ProcessFencePort proof"), restated in the residual-blockers table, and restated again in
   "Relation to prior study" ("Capability for sequential Delivery handoff must stay **unavailable** until a
   certified adapter satisfies containment **and** the audit clause"). Consistent throughout, no drift.
10. **EACCES still blocks the independent audit.** Explicitly carried forward, not silently dropped: "The
    independent same-UID worktree `cwd`/`root`/open-FD audit incompleteness documented in the prior study remains
    a residual blocker for full `proven_empty` on this host," repeated in the "Not proved" table citing the same
    three unreadable processes (`systemd`, `(sd-pam)`, `postgrest`) from the T0.2 study.

## Allowed verification (as scoped by the review contract)

- Read both study documents in full (327 + 303 lines).
- Independently re-ran every read-only host-fact command from the report; all outputs matched exactly.
- Extracted and byte-diffed the report across its full migration history (`ba2599c4` → `68e7af82`); identical.
- Confirmed the canonical verification record (`accept`, no waiver, no findings) and that the diffstat for the
  full candidate branch touches only the study file and its generated test stub.
- Did not perform any cgroup/systemd-unit mutation myself — outside this review's granted scope (that authorization
  was specific to the `processFenceCgroupGrokR1` delegation, not this review).

## Verdict

**ACCEPT.** The report is authentic (byte-identical across its packaging migration, independently host-corroborated
on every checkable fact), methodologically sound (each of the ten scrutiny points is backed by a specific,
separately-designed experiment rather than inference), and consistently, repeatedly self-limiting about what a
`PASS` here does and does not authorize. No concrete defect, overclaim, or evidentiary gap found. The report
correctly leaves `proven_empty` unavailable and sequential Delivery handoff disabled pending the still-unresolved
independent worktree-binding audit.
