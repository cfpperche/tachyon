# 213 — tachyon-worktree-diff-review — plan

## Architecture

Pure changed-set computation + diff-input construction in a new tiny module; the
side-effecting git reads and the VS Code wiring (content provider + quick-pick + diff)
in the extension. Mirrors the spec-210/212 pure-first split.

```
src/worktree/review.ts (new — pure-ish)
  ├─ parseNameStatus(out): {status:'A'|'M'|'D'|'R'|'C', path:string}[]   # parse `git diff --name-status`
  ├─ mergeChanges(tracked, untracked): ChangedFile[]                     # ∪ untracked (as 'A'), dedup, sorted
  └─ diffInputs(file, baseRef): { leftQuery, rightIsEmpty, title }       # what side is empty (A→empty base, D→empty current)

src/worktree/WorktreeManager.ts
  └─ changedFiles(cwd, baseRef): Promise<ChangedFile[]>   # git diff --name-status <baseRef> ∪ ls-files --others; uses gitArgs
     showFile(cwd, ref, file): Promise<string>            # `git show <ref>:<file>` content for the base side ("" if absent)

src/extension.ts
  ├─ TextDocumentContentProvider("tachyon-worktree") — URI carries {agent,ref,file}; body = manager.showFile(...)
  └─ tachyon.reviewWorktreeItem — read ledger WorktreeRecord → manager.changedFiles → quick-pick →
        vscode.diff(tachyon-worktree:base, file://<path>/<file>, title); empties handled per status.

package.json — command + inline/context menu entry `when viewItem =~ /worktree/`; nls (en+pt-br).
```

## Sequencing

1. Pure `review.ts` (parse name-status, merge untracked, diff-input rules) + unit tests.
2. WorktreeManager `changedFiles` + `showFile` (gitArgs builders) + a real-git integration
   test on a tmp worktree (committed + uncommitted + untracked + a delete).
3. Extension: content provider + `reviewWorktreeItem` command + quick-pick + `vscode.diff`.
4. package.json command + menu + nls; README worktree section gets a "Review changes" line.
5. Live smoke (EDH): a worktree agent with edits → Review changes → quick-pick → native diff.

## Risks / edges

- **Added/untracked** → base side empty (provider returns "" when `git show` fails).
- **Deleted** → current side empty: diff against an empty right (a `tachyon-worktree` empty URI).
- **Binary files** → `git show` returns bytes; show a notice / skip in the quick-pick (mark binary).
- **Renames** (`R100 old new`) → surface the new path (post-image); base side = old path content.
- **Worktree removed after spawn** → `changedFiles` git call fails → notice, no crash.
- **baseRef rewritten/gone** → `git show <baseRef>:file` fails → treat base as empty (still shows current).
