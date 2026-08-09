# 497 — plan

_Created 2026-08-08._

## Approach

The change is small in mechanism and large in reach, so it is sliced by **who produces and who reads**
rather than by file. The invariant that makes slicing safe: at no point may the writer and the reader
disagree about where evidence lives. That is the one thing this plan refuses to spread across two
slices.

Nothing here executes a check. `t-6ca846` removes the product's ability to run one; this spec replaces
where the resulting proof lands.

### Why a ref is the right container, in this repository specifically

`readVerificationRecord` already resolves its storage through `git rev-parse --git-common-dir`, for a
reason stated in its header: the gate runs inside an **agent's worktree** and the host reads from the
**primary checkout**, and only the common dir is shared by both. Refs live in that same common dir.
So the ref inherits the exact property the current file was chosen for, and adds one the file cannot
have: it can be pushed and fetched.

### Slices

**S1 — the record moves from file to ref, locally. Atomic.**
`scripts/verify-record.mjs` stops writing `<common-dir>/tachyon-verify/<tree>.json` and starts writing
`refs/tachyon/verify/<tree>` (`git hash-object -w --stdin` → `git update-ref`). `verifyRecordReader.ts`
reads with `git cat-file blob refs/tachyon/verify/<tree>` through its already-injected `GitExec`. Same
JSON, same validity contract (`scripts/verify-record-validity.cjs`), same consumers — `land.ts` and
`GatedCompletionMonitor` do not change. No network. Writer and reader flip together or not at all.

**S2 — three answers instead of two.**
`readVerificationRecord` currently returns a record or `undefined`, and `undefined` is doing two jobs.
It becomes a discriminated result: `verified` / `not-fetched` / `absent`, each with a reason. The
`not-fetched` arm is decided by one `git ls-remote refs/tachyon/verify/<tree>`, issued **only** when a
human opens the surface — never from the 3s tick. `land.ts` renders the distinction; the `fix` text
stops telling the project to run our gate.

**S3 — the one-click fix.**
On `not-fetched`, the surface offers writing `+refs/tachyon/*:refs/tachyon/*` into
`remote.<name>.fetch`. The product composes it; the human's click applies it. Nothing writes git config
without that click.

**S4 — CI publishes.**
`.github/workflows/ci.yml` gains a post-gate step that pushes the ref. This is the slice that proves
the claim "any CI, with nothing but git" — the step must be short enough to paste into a spec as an
example, and it doubles as the documentation.

**S5 — retention.**
Publishing prunes. The file had `KEEP = 50`; refs do not prune themselves.

## Key decisions

Ratified decisions live in `spec.md` § Decisions. What follows is implementation-level and mine.

**The validity contract is reused, not reimplemented.** `scripts/verify-record-validity.cjs` already
exists precisely because two sides needed one rule (t-40e655), and it is already consumed from both
`.mjs` and `src/` — the latter through a `.cjs` + `.d.cts` pair, because `src` compiles as CommonJS and
cannot statically import an `.mjs`. Adding a third storage location must not add a second rule.
_Rejected:_ a fresh validity check inside the ref reader, which is how the defect t-40e655 fixed was
born in the first place.

**The reader keeps taking an injected `GitExec`.** It runs on the extension host's tick and a
synchronous subprocess there wedges the UI — a first cut did exactly that and `cxWedgeBehavior.gen`
caught it. Reading a ref is another git call, so the constraint tightens rather than relaxes.

**`ls-remote` is on-demand and named as network.** It is the only network call this design adds. It is
per-tree, not per-sweep, and it must be impossible to reach from the poll. _Rejected:_ resolving all
three states eagerly so the panel is always current — that pays a network round trip per worktree row
per tick.

**Fail-closed keeps its exact current meaning.** A git failure, an unreadable blob, a record whose
`tree` disagrees with its ref name, an unparseable timestamp: all `absent`, never `verified`. The new
`not-fetched` state is not a softening — it is a *fourth* honest answer that used to be collapsed into
"absent", and collapsing it is what made the panel say "not proved green" about a tree CI had proved.

## Files touched

| File | Change |
|---|---|
| `scripts/verify-record.mjs` | write the ref instead of the file; prune (S1, S5) |
| `scripts/verify-record-validity.cjs` | unchanged — reused as-is |
| `src/workspace/verifyRecordReader.ts` | read the ref; return the three-state result (S1, S2) |
| `src/worktree/land.ts` | render `not-fetched` distinctly; new fix text (S2) |
| `src/workspace/GatedCompletionMonitor.ts` | adapt to the result shape; behaviour unchanged (S1) |
| the land surface in `src/webview/worktrees/` | the fix action (S3) |
| `.github/workflows/ci.yml` | publish step (S4) |
| `docs/` | the publish recipe, as a script a non-Node project can copy (S4) |

## Risks

**The one that would be silent:** S1 flips storage for evidence that arms a human `git merge`. If the
reader looked in the new place while the writer still used the old one, every tree would read as
unverified and the land door would close — loudly, which is survivable. The dangerous inverse is a
partial flip where some path still writes the file and something still reads it, so **the old path must
be deleted, not left as a fallback**.

**Ref names are shared across worktrees, so a concurrent publish is a real race.** Two agents finishing
gates on the same tree at the same second both `update-ref`. Same content, so last-writer-wins is
harmless — but this should be stated rather than discovered.

**`git ls-remote` on a repository with no remote, or offline.** Must answer "cannot tell" and be
rendered as such; an offline machine must not read as "no evidence".

**Blob-valued refs.** Unusual but legal. If a tool in this repo's own path (packing, gc, a hosting
provider's push validation) rejects them, that is a measurement that flips spec Decision 2. S1 is where
it would show up.
