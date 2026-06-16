# 223 — tachyon-worktree-pr — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Implementation
- [x] 1. **`src/worktree/pr.ts`** — pure (isGitHubRemote, prReadiness, composePrTitle, composePrBody)
      + impure behind an injectable `CliExec` seam (originUrl, probePrReadiness, createWorktreePr). No
      `--base` (baseRef is a fork-point SHA → let gh default to the repo default branch).
- [x] 2. **extension.ts** `tachyon.createWorktreePrItem` — readiness probed at CLICK (D3, no per-refresh
      gh spawn); editable title + modal body-preview confirm (D2); createWorktreePr; notify + "Open PR".
- [x] 3. **package.json / nls / l10n** — command + inline menu gated `viewItem =~ /worktree/`, hidden
      from palette; titles (en + pt-BR) + the 9 runtime pt-BR strings.
- [x] 4. **test/unit/pr.test.ts** — readiness matrix, github-url, body verdict (✓/✗/⊘), probe (authed /
      not-authed / gh-absent), create (push→create, already-exists→existing, push-fail). 492 green.
- [x] 5. **codex dueto — 6 rounds → SHIP.** r1: 3 MAJOR (no-base→wrong base; dirty omitted; stale-cwd
      escape). r2: 2 MAJOR (name-rev base ambiguous → PERSIST baseBranch at create; fallback text false).
      r3: 2 MAJOR (push `+`-branch force-refspec → fully-qualified refspec; attach path persisted wrong
      base → create-only). r4: 2 MINOR (`gh pr view` numeric-branch ambiguity → `pr list --head`; body
      false provenance → base-branch line). r5: 1 MAJOR (attached/pre-223 still GUESSED base) → **removed
      resolveBaseBranch entirely; base is ONLY the persisted one, never guessed**. r6: **SHIP**.
- [x] 6. **Shipped 0.20.0** — build → `vsce publish minor` → push main + tag `v0.20.0`.

## Design evolution (from the dueto)
- The PR base is now ONLY `WorktreeRecord.baseBranch`, persisted at worktree-CREATE (a true fork off a
  known branch). Never derived/guessed from the fork-point SHA. Attached or pre-223 worktrees → no
  `--base`, no body base line; gh defaults and the confirm says "confirm on the PR page". Honest > a
  confident wrong guess.
- Push uses a fully-qualified refspec (`refs/heads/X:refs/heads/X`) so a `+`-prefixed branch name can't
  become a force-push. Existing-PR lookup uses `gh pr list --head <branch>` (a branch filter), not the
  ambiguous `gh pr view <branch>`.

## Notes
- v1 scope (D4): one PR at a time; no batch; no Bridge tool (no agent firing a PR). Human at the gate
  (D2). Verify-green not required (D3) — the verdict is reflected honestly in the body.
- Headline value = the verify verdict travels into the PR body + the one-click from a verified worktree;
  the bare `gh pr create` an agent could already run is the modest part. Built on the maintainer's go.
