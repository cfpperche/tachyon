#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SDD="/home/goat/tachyon-plugins/sdd/skills/sdd"
NEW_SH="$SDD/scripts/new.sh"
CHECK_IDS="$SDD/scripts/check-ids.sh"

tmp="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

git init "$tmp/repo" >/dev/null
git -C "$tmp/repo" config user.email "sdd-smoke@example.invalid"
git -C "$tmp/repo" config user.name "SDD Smoke"
mkdir -p "$tmp/repo/docs/specs/001-base"
printf 'base\n' > "$tmp/repo/docs/specs/001-base/spec.md"
git -C "$tmp/repo" add docs/specs/001-base/spec.md
git -C "$tmp/repo" commit -m base >/dev/null
git -C "$tmp/repo" worktree add -b wt2 "$tmp/wt2" >/dev/null

(cd "$tmp/repo" && sh "$NEW_SH" alpha > "$tmp/alpha.out") &
p1=$!
(cd "$tmp/wt2" && sh "$NEW_SH" beta > "$tmp/beta.out") &
p2=$!
wait "$p1"
wait "$p2"

alpha_dir="$(sed -n 's/^Scaffolded \(docs\/specs\/[0-9][0-9][0-9]-.*\):$/\1/p' "$tmp/alpha.out")"
beta_dir="$(sed -n 's/^Scaffolded \(docs\/specs\/[0-9][0-9][0-9]-.*\):$/\1/p' "$tmp/beta.out")"
alpha_id="$(basename "$alpha_dir" | sed 's/^\([0-9][0-9][0-9]\)-.*/\1/')"
beta_id="$(basename "$beta_dir" | sed 's/^\([0-9][0-9][0-9]\)-.*/\1/')"

if [[ -z "$alpha_id" || -z "$beta_id" || "$alpha_id" == "$beta_id" ]]; then
  echo "expected distinct concurrent ids, got alpha='$alpha_id' beta='$beta_id'" >&2
  cat "$tmp/alpha.out" >&2
  cat "$tmp/beta.out" >&2
  exit 1
fi

(cd "$tmp/repo" && sh "$CHECK_IDS") >/dev/null
(cd "$tmp/wt2" && sh "$CHECK_IDS") >/dev/null

mkdir -p "$tmp/dup/docs/specs/300-a" "$tmp/dup/docs/specs/300-b"
if (cd "$tmp/dup" && sh "$CHECK_IDS") >/dev/null 2>"$tmp/dup.err"; then
  echo "duplicate checker unexpectedly passed" >&2
  exit 1
fi
grep -q "duplicate spec id 300" "$tmp/dup.err"

mkdir -p "$tmp/nongit/docs/specs/001-base"
(cd "$tmp/nongit" && sh "$NEW_SH" nongit) >/dev/null
test -d "$tmp/nongit/docs/specs/002-nongit"

if grep -R "flock" "$SDD/scripts/new.sh" "$SDD/scripts/check-ids.sh" >/dev/null; then
  echo "sdd scripts must not depend on flock" >&2
  exit 1
fi

echo "spec-296 smoke ok: alpha=$alpha_id beta=$beta_id"
