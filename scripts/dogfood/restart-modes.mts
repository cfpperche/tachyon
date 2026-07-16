/**
 * Spec 389 headless dogfood entry (wrapper).
 * Prefer: npm run dogfood:restart-modes
 *
 * Runs real-tmux matrix: force+new, force+resume→new, graceful+new (cooperative + sticky
 * force-fallback), product default graceful+resume→new. Evidence under
 * .tachyon/evidence/restart-modes-dogfood/latest.json
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const r = spawnSync(
  path.join(root, "node_modules", ".bin", "vitest"),
  ["run", "test/integration/restartModesDogfood.test.ts"],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
