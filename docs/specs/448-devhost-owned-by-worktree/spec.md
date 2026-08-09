# 448 — devhost-owned-by-worktree

_Created 2026-07-24._

**Status:** shipped
**Closure:** Merged to main 2026-07-24 (e2fa3da1, t-55a5ac). The dev-host is rooted in the checkout
that owns it; slots, `active`, the primary-monorepo redirect for the dev-host root, and the per-slot
rewriting of a tracked `launch.json` are deleted (`pointer.mjs` 1501 → 1032 lines). Retired flags fail
immediately naming their replacement. Two structural guards keep the layout from returning:
`devHostNoSlots.test.ts` (bans the layout, both proved non-vacuous) and `devHostLaunchConfig.test.ts`
(pins the F5 wiring the headless harness cannot reach). verify:full green in isolation (503 files, 5649 passed at e2fa3da1) and green again on the combined main after the agent-pane merge and its two follow-up fixes (507 files, 5679 passed).
Migration done: 583M of orphan slots reclaimed from the primary and its `launch.json` restored.

**Verify:** `npm run typecheck`
**Verify:** `npx vitest run test/unit/devHostPointer.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostLane.test.ts test/unit/devHostLauncher.test.ts`
**Dogfood:** `npm run dogfood -- dev-host -- point --fixture agent-soul-dogfood && npm run dogfood -- dev-host -- point-status && npm run dogfood -- dev-host -- point-clear`

## Intent

Maintainer's objective, verbatim (2026-07-24): *"trabalhamos com vários agentes em várias worktrees,
precisamos deixar agentes criarem fixtures e apontarem sua worktree para rodarmos o EDH a partir
desse workspace ... um agente não pode dominar o devhost, por isso criamos os slots."*

The dev-host lives in `.tachyon/dev-host/` of the **primary monorepo** — one shared directory inside
one shared checkout. Every other mechanism exists to manage that sharing: **slots** partition it,
the **`active` symlink** selects which slot F5 uses, `.vscode/launch.json` is **rewritten** to index
the slots, and `resolveF5HostRepoRoot` (`pointer.mjs:89`) redirects a linked worktree back to the
monorepo so F5 can find the pointer. Isolation is therefore a *convention over a shared resource* —
policy that every participant must respect — rather than a structural property.

Two costs are measured, not theoretical:

1. `.vscode/launch.json` is **tracked**, and `pointer.mjs:793` writes a per-slot entry into it. Every
   agent that arms rewrites a tracked file, so the primary checkout is **permanently dirty**. That
   destroys `git status` as a clean-tree signal — for humans and for agents that gate on it.
2. A slot's lifetime is decoupled from the worktree it serves. `slots/codex` (126M) and `slots/grok`
   (462M) were live on 2026-07-24 with no corresponding grok worktree; reclaiming is a manual
   `point-clear`. This feeds `t-2a2af8` (VHDX growth).

The agent already has an isolated space: **its worktree**. A worktree is a full checkout — it has its
own `.vscode/` and `.tachyon/` is gitignored in every checkout (`.gitignore:13`). "Done" is: the
dev-host is owned by the checkout it serves. Each worktree hosts its own dev-host at a fixed relative
path, so `launch.json` becomes a static committed file that is **identical everywhere and never
generated**, and slots / `active` / `--owner` / `--slot` / the redirect are deleted. Isolation stops
being policy and becomes structure: there is no shared dev-host left to dominate.

## Acceptance criteria

- [x] **Scenario: two agents dogfood at the same time without coordinating**
  - **Given** agents A and B working in two different worktrees, each having armed a dev-host
  - **When** both run their EDH (headless or F5) at the same time
  - **Then** each one launches against its own checkout's `.tachyon/dev-host/`, neither observes nor
    mutates the other's state, and neither had to choose or be assigned a slot identifier

- [x] **Scenario: arming a dev-host never dirties a tracked file**
  - **Given** any checkout with a clean working tree
  - **When** an agent or a human arms a dev-host there (points a worktree, creates a fixture, runs the
    headless harness)
  - **Then** `git status --porcelain` reports exactly what it reported before — every byte written
    lands under the gitignored `.tachyon/`

- [x] **Scenario: removing a worktree reclaims its dev-host**
  - **Given** a worktree whose dev-host holds materialized state (extension, workspace, VS Code data)
  - **When** the worktree is removed through the managed path (`remove_worktree`)
  - **Then** that dev-host's bytes are gone with it, with no separate cleanup step and no orphaned
    directory left in the primary monorepo

- [x] **Scenario: the headless harness targets its own checkout**
  - **Given** the headless dev-host harness invoked from inside a worktree
  - **When** it resolves where to launch the EDH from
  - **Then** it resolves that worktree's own `.tachyon/dev-host/`, with no `active` symlink
    indirection and no redirect to the primary monorepo

- [x] **Scenario: a retired flag fails loudly with the replacement**
  - **Given** an agent prompt, script, or runbook step still passing `--owner` or `--slot`
  - **When** the command runs
  - **Then** it fails with a message naming the replacement flow rather than silently ignoring the
    flag or half-arming a dev-host

- [x] `.vscode/launch.json` is byte-identical in every checkout, is written by no script, and its Dev
      Host entry resolves through `${workspaceFolder}/.tachyon/dev-host/…`.
- [x] No source, script, test, or doc references `.tachyon/dev-host/active` or a `slots/` layout,
      enforced by a test so the layout cannot be reintroduced silently.
- [x] `docs/runbooks/dev-host.md` describes the one flow (arm inside your worktree, open VS Code
      there, F5) and states that worktrees grow by the size of their dev-host.
- [x] The migration leaves no residue: the slot entries currently dirtying the primary checkout's
      `launch.json` are gone, and pre-existing `slots/` directories are reclaimed or documented as
      manually reclaimable.

## Non-goals

- **Generating a `.code-workspace` to get a single-window menu.** Dropped 2026-07-24, not deferred:
  the maintainer already runs a multi-root workspace, and VS Code already disambiguates launch configs
  by folder (`Tachyon: Dev Host (devhost-owned-by-worktree)`). A static per-checkout `launch.json`
  therefore yields the every-worktree menu for free, in one window. There is nothing left to build.
- **Changing what a dev-host contains** (extension build, fixture seeding, engine runtime layout).
  This spec moves ownership; it does not redesign the payload.
- **Sharing or deduplicating dev-host bytes between worktrees.** Disk-sharing strategy belongs to
  `t-2a2af8`; this spec only stops the leak of orphaned slots.
- **The headless harness's CDP/scenario surface.** `4c58cee8` just taught it to resolve
  `active` → `slots/<id>`; this spec retargets that resolution and must not otherwise alter behavior.

## Open questions

- **Does opening VS Code on a linked worktree force a WSL re-entry?** `docs/runbooks/dev-host.md:48`
  warns against changes that trigger *"Disconnected from WSL"* / *"Extension 'WSL' is required"*. That
  warning is about machine-local absolute paths and everything here is `${workspaceFolder}`-relative,
  so the expectation is no — but this is **untested**, and it is the assumption the whole design rests
  on. Resolution: prove it in dogfood before any deletion lands. Owner: claude.
- ~~**How far does the deprecation window extend?**~~ **Resolved 2026-07-24 by the maintainer: no
  window — retired flags fail immediately, naming the replacement.** No warn-then-remove release. This
  is now fixed by the "a retired flag fails loudly" acceptance scenario above; a caller still passing
  `--owner`/`--slot` must get a hard error, never a silent no-op or a half-armed dev-host.
