/**
 * spec 284 — the standalone DATA-RESOLVER entry. Bundled (no `vscode`) to `dist/data-resolver.cjs` and copied to
 * `<workspace>/.tachyon/bin/_tachyon-data.js` on every managed op. A plugin's skill invokes the shim with no VS
 * Code running, so it must be self-contained. The workspace root is derived from its own on-disk location
 * (`.tachyon/bin/_tachyon-data.js` → `../..`). The sibling of `toolLauncherEntry.ts`.
 */

import path from "node:path";
import { runDataResolver } from "./plugins/dataLauncher.js";

const workspaceRoot = path.resolve(__dirname, "..", "..");
process.exit(runDataResolver(process.argv.slice(2), { workspaceRoot }));
