# 213 — tachyon-worktree-diff-review — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [ ] 1. **Pure `src/worktree/review.ts`**: `ChangedFile` type ({status, path, binary?});
      `parseNameStatus(out)` (handles A/M/D and `R###`/`C###` old→new, post-image path);
      `mergeChanges(tracked, untracked)` (untracked → status 'A', dedup by path, sorted);
      `diffTitle(file, baseRef)` + the per-status empty-side rule (A→empty base, D→empty
      current). Unit-tested, no git.
- [ ] 2. **WorktreeManager**: `changedFiles(cwd, baseRef)` = `git diff --name-status <baseRef>`
      ∪ `git ls-files --others --exclude-standard` → `ChangedFile[]` (via review.ts);
      `showFile(cwd, ref, file)` = `git show <ref>:<file>` content, "" on failure (absent/binary
      guarded). gitArgs builders. Real-git integration test on a tmp worktree:
      modified / added / untracked / deleted / rename, against baseRef.
- [ ] 3. **Extension content provider + command**: register a `TextDocumentContentProvider`
      for scheme `tachyon-worktree` (URI encodes agent+ref+file → `manager.showFile`);
      `tachyon.reviewWorktreeItem` reads the ledger `WorktreeRecord`, calls `changedFiles`,
      shows a quick-pick (status glyph + path), and on pick opens `vscode.diff(base, current,
      title)` — current = `file://<path>/<file>` (or empty for a delete). Empty set / missing
      worktree → notice. Dispose the provider with the extension.
- [ ] 4. **package.json + nls**: `reviewWorktreeItem` command (`$(git-compare)` icon) + a
      `view/item/context` entry `when viewItem =~ /worktree/`; titles in en + pt-br.
- [ ] 5. **Docs**: README worktree section — a "Review changes (native diff, base ↔ current)" line.
- [ ] 6. **Live smoke** (EDH): a worktree agent with committed + uncommitted + an untracked
      file → Review changes → quick-pick lists them → selecting opens the native diff; added
      shows empty base, deleted empty current.

## Notes
- Pure-first per 210/212; the quick-pick + vscode.diff wiring is the only non-headless part
  (live smoke). C3 (verify-gate) stays a separate spec; C2 only READS the worktree.
