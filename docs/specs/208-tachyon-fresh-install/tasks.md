# 208 — tachyon-fresh-install — tasks

## Implementation
- [x] 1. Lazy activation: boot only configured folders; ensureWorkspaceFor + pickFolderForCreate (boot on create)
- [x] 2. tachyon.checkRequirements (doctor) + tachyon.getStarted (open walkthrough)
- [x] 3. contributes.walkthroughs (5 steps, real media, completionEvents) + media/walkthrough/*
- [x] 4. viewsWelcome -> Init + walkthrough; package.json commands; nls/l10n; 0.6.6
- [x] 5. README/landing fresh-install note + walkthrough screenshot

## Verification
**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`
- [x] Unit 211/211
- [x] xvfb 22 single-root (hot path unchanged) / 6 multi-root
- [x] walkthrough media bundled in the .vsix (vsce ls)

## Notes
The empty-state welcome bug (Bridge node kept the Agents tree non-empty) is fixed structurally by lazy activation: a look-only folder has no Workspace, so no Bridge node, so the tree is empty and viewsWelcome renders.
