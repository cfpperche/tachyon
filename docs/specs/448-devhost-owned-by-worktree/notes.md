# 448 — devhost-owned-by-worktree — notes

_Created 2026-07-24._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T1 result — the assumption HOLDS mechanically (2026-07-24)

Ran against the real inverted code (T2/T3), not a mock. In the linked worktree
`.../change/devhost-owned-by-worktree`:

- `node scripts/dev-host/pointer.mjs point --fixture agent-soul-dogfood` armed a dev-host **flat in
  the worktree** — `.tachyon/dev-host/{extension,workspace,runtime,meta.json,user-data,extensions,
  tmux,cache,profile-home}`, no `slots/`, no `active`.
- The primary monorepo was **not touched** by the arm (`git status` there unchanged).
- The worktree's tracked files were **not touched** either — the only dirt was my own source edits.
  That is spec acceptance scenario 2 already satisfied.
- `headless-session.mjs up` → `{"ok":true,"browser":"Chrome/148.0.7778.271","edhPid":3631881}` with
  `outDir` inside the worktree.
- The EDH opened `file:///…/change/devhost-owned-by-worktree/.tachyon/dev-host/workspace` — the
  worktree's own workspace mirror.
- **The extension actually activated**, not just the window: `exthost.log` records
  `ExtensionService#_doActivateExtension cfpperche.tachyon, startup: true, activationEvent:
  'workspaceContains:tachyon.yml'`, with no tachyon-related error.

Checking `frames`/`eval` alone would NOT have proven this — a VS Code window opens whether or not the
extension loads. The activation line in `exthost.log` is the evidence that matters.

**Still owned by the maintainer:** the Remote-WSL *window* attach. Headless runs under Xvfb and has no
Remote-WSL, so it cannot show whether opening a VS Code window on a linked worktree keeps the WSL
connection. Everything mechanical below that (path resolution, extension load, EDH boot, workspace
selection) is now proven. The residual is one human F5.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### T1 runs after T2/T3, not before them (2026-07-24)

`tasks.md` puts T1 (prove the WSL/path assumption) first and says nothing is deleted until it passes.
Kept the gate, moved the proof: T2/T3 (flatten `pathsOf`, root the dev-host in the current checkout)
are **inversions, not deletions**, so running them first does not breach the gate — and it lets T1 be
proven against the real implementation instead of a hand-built mock of the target layout. A mock would
have proven only that I can assemble directories correctly, which was never the risk.

Enabler found while reading: `headless-session.mjs:48` computes `REPO` from its own file location
(`path.resolve(here, "..", "..")`), so the headless harness **already** roots in whatever checkout it
lives in, and `resolvePointerSlotRoot` falls through to that checkout's `dev-host/` when no `active`
symlink exists. The harness was never the thing redirecting to the primary monorepo — only
`pointer.mjs` was. That shrinks T7 and means the headless half of T1 exercises a path the harness
already supports.

**Still unproven and still owned by the maintainer:** whether opening a VS Code *window* on a linked
worktree keeps the Remote-WSL connection. Headless (Xvfb) cannot show that — it has no Remote-WSL
attach. The headless run proves path resolution, extension load and EDH boot from a worktree-rooted
dev-host; the window attach needs a human F5.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
