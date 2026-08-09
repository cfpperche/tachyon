# 497 — tasks

_Created 2026-08-08._

**Verify:** `npm run verify:full:quiet`

**Dogfood:** `node scripts/verify-record.mjs audit`

Ordered. Each slice leaves `main` green on its own. S1 is the only one that must land as a single
commit — writer and reader may never disagree about where evidence lives.

## S1 — the record moves from file to ref (atomic)

- [ ] Red first: a test that publishes a record for a tree and reads it back through
      `readVerificationRecord`, failing today because nothing writes a ref.
- [ ] `scripts/verify-record.mjs`: write `refs/tachyon/verify/<tree>` (`git hash-object -w --stdin`
      → `git update-ref`) instead of `<common-dir>/tachyon-verify/<tree>.json`.
- [ ] `src/workspace/verifyRecordReader.ts`: read with `git cat-file blob` through the injected
      `GitExec`. Keep the validity contract call exactly as it is — no second copy of the rule.
- [ ] Delete the file path entirely. No fallback reader, no dual write. (plan.md § Risks: a partial
      flip is the dangerous shape.)
- [ ] Prove the cross-worktree property still holds: a record published from an agent worktree is
      readable from the primary checkout. This is why the storage was in the common dir at all.
- [ ] Prove a blob-valued ref survives this repo's own git path (a `git gc` and a `git push` of that
      ref). If it does not, stop — spec Decision 2 flips.
- [ ] `land.ts` and `GatedCompletionMonitor` unchanged in behaviour; their tests stay green untouched.

## S2 — three answers instead of two

- [ ] Red first: a test asserting that "published on the remote, absent locally" is distinguishable
      from "nowhere at all". It cannot pass today — both are `undefined`.
- [ ] Change `readVerificationRecord`'s return to a discriminated result: `verified` / `not-fetched`
      / `absent`, each carrying a reason string.
- [ ] `not-fetched` is decided by one `git ls-remote refs/tachyon/verify/<tree>`, on demand only.
- [ ] Guard that the tick cannot reach it: the 3s sweep path must not issue `ls-remote`. Write the
      test that fails if it ever does.
- [ ] No remote, or offline: answers "cannot tell", rendered as such. Never "no evidence".
- [ ] `land.ts` renders the three states; the `fix` text for `absent` stops naming our gate.

## S3 — the one-click fix

- [ ] On `not-fetched`, the surface offers writing `+refs/tachyon/*:refs/tachyon/*` into
      `remote.<name>.fetch`.
- [ ] Red first: a test proving the product does NOT write git config on its own — the config is
      untouched until the action is invoked.
- [ ] Idempotent: invoking it twice does not append a duplicate refspec.
- [ ] Multi-remote: use the remote the branch tracks, and name which one was used. (spec.md § Open
      questions #2 — resolve it here.)

## S4 — CI publishes

- [ ] `.github/workflows/ci.yml`: after a green gate, publish and push the ref.
- [ ] The step is short enough to paste as documentation, and uses nothing but `git`.
- [ ] `docs/`: the publish recipe as a copyable shell snippet, written for a project that is not
      Node and has never seen this repository.
- [ ] Dogfood: push a branch, let CI publish, fetch, and watch the land precondition go green with no
      local gate run. This is the acceptance scenario the whole spec exists for.

## S5 — retention

- [ ] Decide the rule and record it in notes.md (count, age, or reachability). The file used
      `KEEP = 50`; refs do not prune themselves. (spec.md § Open questions #1.)
- [ ] Publishing prunes. A prune must never remove the record for the tree being published.

## Visual QA

Applies to S2 and S3 — the land block gains a state and an action.

- [ ] Evidence: screenshots of the three states in Control → Worktrees.
- [ ] Verdict: recorded after looking, including anything fixed as a result.
