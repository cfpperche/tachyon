#!/bin/sh
# t-588644 — update demo-drifty the way a real plugin update does: same paths, new bytes, new
# version in the lock. Run it from the EDH's `shell` terminal after BOTH agents are set up.
#
# The update is not the subject here; the blast radius is. It leaves `pinned`'s reference naming
# bytes that no longer exist, so its profile is refused at the next config load — and the question
# is whether `bystander`, which authorized a plugin that did not move, survives that.
#
# It refuses to run anywhere but the dev-host MIRROR. The fixture under test/fixtures/ is tracked,
# and a hand-driven scenario that mutates its own source would make the next run start from a state
# nobody chose — and would show up as an unexplained diff in the repo.
set -e
cd "$(dirname "$0")"

if [ ! -f .tachyon-dev-host.json ]; then
  echo "drift.sh: refusing — this is the tracked fixture source, not the dev-host mirror." >&2
  echo "  run it from: <checkout>/.tachyon/dev-host/workspace/drift.sh" >&2
  echo "  (arm first: npm run dogfood -- dev-host -- point --worktree <wt> --fixture agent-config-blast-radius)" >&2
  exit 1
fi

cat > .tachyon/plugins/demo-drifty/skills/demo-drifty/SKILL.md <<'EOF'
---
name: demo-drifty
description: The subject, updated. The pin captured at v1 no longer matches these bytes.
---

# demo-drifty v2 — the corrected content

The update landed. `pinned`'s reference still names the v1 tree, so its profile is refused. That
refusal is correct. Taking `bystander` down with it is not.
EOF

# A real update rewrites the materialized copies too. The digest that decides the refusal is taken
# over the plugin payload above, but leaving these at v1 would make the fixture lie about what an
# update looks like on disk.
#
# Only where the mirror actually owns them. `point` copies `.tachyon`, `.claude` and `.codex` for
# real and SYMLINKS every other child back into the tracked fixture — so a blind `cp` into
# `.agents/` would write straight through into test/fixtures/, which is the source this script
# refuses to touch three lines up. Skip it out loud rather than corrupt the repo quietly.
for rel in .claude/skills/demo-drifty .agents/skills/demo-drifty; do
  root="${rel%%/*}"
  if [ -L "$root" ]; then
    echo "drift.sh: skipped $rel — the mirror symlinks $root/ back to the tracked fixture."
    continue
  fi
  cp .tachyon/plugins/demo-drifty/skills/demo-drifty/SKILL.md "$rel/SKILL.md"
done

# Bump ONLY demo-drifty's version: the line right after its own "name" key. A blanket replace would
# move demo-stable too, and the control would stop being a control.
sed -i '/"name": "demo-drifty",/{n;s/"version": "1\.0\.0"/"version": "2.0.0"/;}' .tachyon/plugins.lock.json
sed -i 's/"version": "1\.0\.0"/"version": "2.0.0"/' .tachyon/plugins/demo-drifty/tachyon-plugin.json

echo "demo-drifty updated 1.0.0 -> 2.0.0 — 'pinned' now holds a reference to bytes that are gone."
echo "Reload the EDH window, then check the sidebar:"
echo "  PASS  'bystander' is still in the roster, and the banner names only 'pinned'."
echo "  FAIL  the roster is empty, or the banner mentions 'bystander' — the blast radius is back."
