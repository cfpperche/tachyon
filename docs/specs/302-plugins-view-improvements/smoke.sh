#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

npm run -s build >/tmp/tachyon-302-build.out

port="${PREVIEW_PORT:-5274}"
log="/tmp/tachyon-302-preview.log"
PREVIEW_PORT="$port" node scripts/webview-preview/serve.mjs >"$log" 2>&1 &
pid="$!"
trap 'kill "$pid" >/dev/null 2>&1 || true' EXIT

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://localhost:$port/scripts/webview-preview/index.html?view=plugins&fixture=default" >/tmp/tachyon-302-preview.html; then
    break
  fi
  sleep 0.2
done

curl -fsS "http://localhost:$port/dist/webview/plugins.js" >/tmp/tachyon-302-plugins.js

grep -q "Filter installed plugins" /tmp/tachyon-302-plugins.js
grep -q "Sort installed plugins" /tmp/tachyon-302-plugins.js
grep -q "Check.*for updates" /tmp/tachyon-302-plugins.js
grep -q "No installed plugins match" /tmp/tachyon-302-plugins.js

echo "plugins view smoke passed"
