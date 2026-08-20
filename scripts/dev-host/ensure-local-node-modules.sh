#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 EXT NM_SRC" >&2
  exit 2
fi

EXT=$1
NM_SRC=$2

checkout="$(git -C "$EXT" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$checkout" ]; then
  echo "build-dev-host: cannot identify the checkout containing extension $EXT" >&2
  exit 1
fi
checkout="$(cd "$checkout" && pwd -P)"

# Keep the source path lexical: a worktree's own node_modules may itself be a deliberate
# worktree→primary dependency link created by ensureNodeModules. The F5 link must still be
# created only when its source entry belongs to the same checkout as the extension.
source_parent="$(cd "$(dirname "$NM_SRC")" && pwd -P)"
if [ "$source_parent" != "$checkout" ]; then
  echo "build-dev-host: refusing node_modules link across checkouts (extension=$checkout, source=$NM_SRC)" >&2
  exit 1
fi

if [ ! -e "$EXT/node_modules" ]; then
  ln -sfn "$NM_SRC" "$EXT/node_modules"
fi
