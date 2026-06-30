#!/usr/bin/env bash
set -euo pipefail

mode="${1:-verify}"
root="$(git rev-parse --show-toplevel)"
plugins="${SDD_PLUGIN_ROOT:-/home/goat/tachyon-plugins/sdd/skills/sdd}"
dogfood="$plugins/scripts/sdd-dogfood.sh"
close="$plugins/scripts/sdd-close.sh"

[ -x "$dogfood" ] || [ -f "$dogfood" ] || { echo "missing dogfood helper: $dogfood" >&2; exit 1; }
[ -f "$close" ] || { echo "missing close helper: $close" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/docs/specs"
cd "$tmp"
git init -q
git config user.email smoke@example.test
git config user.name "SDD Smoke"

make_spec() {
  local name="$1" status="$2"
  mkdir -p "docs/specs/$name"
  cat >"docs/specs/$name/spec.md" <<EOF_SPEC
# $name

**Status:** $status
**Closure:** smoke fixture

## Acceptance criteria

- [x] fixture acceptance
EOF_SPEC
  cat >"docs/specs/$name/tasks.md" <<'EOF_TASKS'
# tasks

## Verification

- [x] fixture verification
EOF_TASKS
  cat >"docs/specs/$name/notes.md" <<'EOF_NOTES'
# notes
EOF_NOTES
}

make_spec "001-good" "shipped"
printf '\n**Dogfood:** `test -f docs/specs/001-good/spec.md`\n' >> docs/specs/001-good/tasks.md

"$dogfood" docs/specs/001-good >/tmp/sdd-dogfood-preview.out
! grep -q "Dogfood log" docs/specs/001-good/notes.md
"$dogfood" docs/specs/001-good --run
grep -q "## Dogfood log" docs/specs/001-good/notes.md
"$close" docs/specs/001-good

make_spec "002-missing" "shipped"
if "$close" docs/specs/002-missing >/tmp/sdd-close-missing.out 2>&1; then
  echo "expected missing dogfood to fail close" >&2
  exit 1
fi
grep -q "dogfood-missing" /tmp/sdd-close-missing.out

make_spec "003-unrun" "shipped"
printf '\n**Dogfood:** `true`\n' >> docs/specs/003-unrun/tasks.md
if "$close" docs/specs/003-unrun >/tmp/sdd-close-unrun.out 2>&1; then
  echo "expected declared-but-unrun dogfood to fail close" >&2
  exit 1
fi
grep -q "dogfood-unrun" /tmp/sdd-close-unrun.out

make_spec "004-optout" "shipped"
printf '\n**Dogfood-Opt-Out:** historical fixture; no meaningful runtime path\n' >> docs/specs/004-optout/spec.md
"$close" docs/specs/004-optout >/tmp/sdd-close-optout.out
grep -q "dogfood-opt-out" /tmp/sdd-close-optout.out

make_spec "005-empty-optout" "shipped"
printf '\n**Dogfood-Opt-Out:**    \n' >> docs/specs/005-empty-optout/spec.md
if "$close" docs/specs/005-empty-optout >/tmp/sdd-close-empty-optout.out 2>&1; then
  echo "expected empty dogfood opt-out to fail close" >&2
  exit 1
fi
grep -q "dogfood-opt-out-empty" /tmp/sdd-close-empty-optout.out

make_spec "006-section-insert" "shipped"
printf '\n**Dogfood:** `true`\n' >> docs/specs/006-section-insert/tasks.md
cat > docs/specs/006-section-insert/notes.md <<'EOF_NOTES'
# notes

## Dogfood log

## Verification log

### old verification entry
EOF_NOTES
"$dogfood" docs/specs/006-section-insert --run >/tmp/sdd-dogfood-section.out
awk '
  /^## Dogfood log/ { dog=1; ver=0; next }
  /^## Verification log/ { ver=1 }
  dog && !ver && /`true`.*pass/ { found=1 }
  END { exit found ? 0 : 1 }
' docs/specs/006-section-insert/notes.md
"$close" docs/specs/006-section-insert

if [ "$mode" = "dogfood" ]; then
  echo "dogfood smoke passed"
else
  echo "verify smoke passed"
fi
