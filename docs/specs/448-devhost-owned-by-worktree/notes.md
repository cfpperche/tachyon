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

**Human half — PASSED 2026-07-24 (maintainer).** F5 on `Tachyon: Dev Host (devhost-owned-by-worktree)`
opened an `[Extension Development Host]` window with `[WSL: …]` still in the title bar — **no
`Disconnected from WSL`, from a linked worktree**. R1 is closed: the assumption the whole design rested
on holds. Confirmed a second time after the T6 fix, with real workspace content and populated Tachyon
views.

First attempt failed and the fault was mine — see "launch.json path drift" below.

### launch.json path drift — my miss, and what it exposed (2026-07-24)

I invited the maintainer to F5 after T2/T3 but *before* T6. `launch.json` still resolved through
`.tachyon/dev-host/active/…`, which the inversion had removed, so VS Code got a non-existent path:
the EDH opened a phantom empty "workspace" and the Tachyon sidebar rendered blank.

The systemic part is worth more than the fix: **the headless harness could not have caught this and
structurally cannot.** `headless-session.mjs` launches VS Code through the CLI with paths it computes
itself and never reads `launch.json`. F5 and headless are two independent wirings to the same goal, so
a green headless run is not evidence about the maintainer's actual path. Filed as **t-6bc30d**;
`devHostLaunchConfig.test.ts` closes the path-drift class here but is static analysis, not proof that
F5 boots.

### The `.code-workspace` follow-up is dead — the maintainer already has it (2026-07-24)

`spec.md` listed a generated, gitignored `.code-workspace` as a conditional follow-up so one window
could reach every worktree's dev-host. The maintainer's screenshot shows they **already run a
multi-root workspace** (`tachyon` + `runtime-config-visual-prototype` + `devhost-owned-by-worktree`),
and VS Code already disambiguates launch configs by folder: `Tachyon: Dev Host (devhost-owned-by-worktree)`.

So with a static per-checkout `launch.json`, the menu listing every worktree's dev-host **comes for
free** — no generation, no extra file, and no need to switch windows. The follow-up is removed from
non-goals rather than left as a standing invitation to build something already solved.

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

### Scenario 3 proved with real bytes, not by construction (2026-07-24)

"Removing a worktree reclaims its dev-host" is structurally obvious, which is exactly why it was worth
measuring rather than asserting. On the spec's own worktree, in the runbook's order:

- dev-host before: **137M** (worktree total 617M)
- `pointer.mjs clear` → `cleared dev-host of …`, `engine: stopped`, `bridge: absent` — the 137M went,
  and the persistent engine was stopped rather than orphaned
- `remove_worktree` → path gone; nothing left behind in the primary

Total reclaimed this session: 583M of orphan slots from the primary + 137M dev-host + the 617M
worktree. Under the old layout the 137M would have survived in the monorepo as another orphan slot.

### `--owner` means two different things (2026-07-24)

Nearly a trap. `pointer.mjs --owner` was a dev-host slot id (deleted here); `lane.mjs --owner` is a
**lease** owner and is load-bearing for delegated headless pilots. A find-and-replace across
`scripts/dev-host/` would have silently broken the lease system. The structural guard is therefore
path-shaped (`dev-host/slots`, `dev-host/active`) and never matches the bare word "owner" or "slot".

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dogfood log

### 2026-07-24T21:58:20Z — fail (0/1) — source: tasks.md — commit: c5de8462a988919a4e65180f581088e0923c672e
- `npm run dogfood:dev-host -- point-status` — fail

### 2026-07-24T21:58:49Z — pass (1/1) — source: tasks.md — commit: c5de8462a988919a4e65180f581088e0923c672e
- `npm run dogfood:dev-host -- point --fixture agent-soul-dogfood && npm run dogfood:dev-host -- point-status && npm run dogfood:dev-host -- point-clear` — pass
