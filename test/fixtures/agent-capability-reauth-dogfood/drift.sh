#!/bin/sh
# t-4a2a6f — update demo-drifty the way a real plugin update does: same paths, new bytes, new
# version in the lock. Run it from the EDH's `shell` terminal after authorizing both plugins.
#
# It refuses to run anywhere but the dev-host MIRROR. The fixture under test/fixtures/ is tracked,
# and a hand-driven scenario that mutates its own source would make the next run start from a state
# nobody chose — and would show up as an unexplained diff in the repo.
set -e
cd "$(dirname "$0")"

if [ ! -f .tachyon-dev-host.json ]; then
  echo "drift.sh: refusing — this is the tracked fixture source, not the dev-host mirror." >&2
  echo "  run it from: <checkout>/.tachyon/dev-host/workspace/drift.sh" >&2
  echo "  (arm first: npm run dogfood -- dev-host -- point --worktree <wt> --fixture agent-capability-reauth)" >&2
  exit 1
fi

cat > .tachyon/plugins/demo-drifty/skills/demo-drifty/SKILL.md <<'EOF'
---
name: demo-drifty
description: The subject, updated. The pin captured at v1 no longer matches these bytes.
---

# demo-drifty v2 — the corrected content

The update landed. The agent's pin still names the v1 tree, so delivery would refuse this — the
Studio must say so as **Reauthorize**, with the version delta, before a spawn discovers it.
EOF

# A real update rewrites the materialized copies too. The digest that decides Reauthorize is taken
# over the plugin payload, but leaving these at v1 would make the fixture lie about what an update
# looks like on disk.
cp .tachyon/plugins/demo-drifty/skills/demo-drifty/SKILL.md .claude/skills/demo-drifty/SKILL.md
cp .tachyon/plugins/demo-drifty/skills/demo-drifty/SKILL.md .agents/skills/demo-drifty/SKILL.md

# Bump ONLY demo-drifty's version: the line right after its own "name" key. A blanket replace would
# move demo-stable too, and the control would stop being a control.
sed -i '/"name": "demo-drifty",/{n;s/"version": "1\.0\.0"/"version": "2.0.0"/;}' .tachyon/plugins.lock.json
sed -i 's/"version": "1\.0\.0"/"version": "2.0.0"/' .tachyon/plugins/demo-drifty/tachyon-plugin.json

echo "demo-drifty updated 1.0.0 -> 2.0.0."
echo "Reopen Agent Studio: demo-drifty should read [Reauthorize] — authorized at 1.0.0, now 2.0.0."
echo "demo-stable must still read Authorized; if it does not, the detector is reporting false drift."
