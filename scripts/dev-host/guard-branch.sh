#!/bin/sh
# Refuse to launch the Dev Host from a checkout sitting on the trunk.
#
# Why this exists: the Dev Host spawns real agents, and an agent spawned there used to create
# branches and worktrees in whatever repository encloses the sandbox. On 2026-08-16 that produced
# two worktrees nested inside the product repo, at
# .tachyon/dev-host/cache/tachyon/worktrees/<hash>/, plus two stray branches.
#
# The sandbox is now its own git root, which stops the leak at the source. This guard is the second
# half of the owner's rule: dev-host runs from a worktree, never from the trunk checkout. A trunk
# checkout is where releases are cut; it is not a place to exercise a product that writes to disk.
#
# Environment harness, not Tachyon product. Nothing here ships in the extension.
set -eu

WF="${1:-}"
[ -n "$WF" ] || { echo "guard-branch.sh: missing workspace folder argument" >&2; exit 2; }

# Not a repository at all — nothing to guard, let the caller proceed.
git -C "$WF" rev-parse --git-dir >/dev/null 2>&1 || exit 0

BRANCH="$(git -C "$WF" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

case "$BRANCH" in
  main|master)
    echo "docs/runbooks/dev-host.md:1:1: error: Dev Host refuses to launch from '$BRANCH'. Use a worktree." >&2
    echo "Dev Host refuses to launch from the trunk checkout." >&2
    echo "  checkout: $WF" >&2
    echo "  branch:   $BRANCH" >&2
    echo "" >&2
    echo "The Dev Host spawns real agents. Run it from a worktree so the trunk checkout stays" >&2
    echo "the place releases are cut from, and nothing else." >&2
    echo "" >&2
    echo "  git -C $WF worktree add ../tachyon-devhost -b tachyon/devhost" >&2
    echo "  then F5 from that folder" >&2
    exit 1
    ;;
esac

exit 0
