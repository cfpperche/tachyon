/**
 * spec 265 — the standalone tool-launcher entry. Bundled (no `vscode`) to `dist/tool-launcher.cjs` and copied
 * to `<workspace>/.tachyon/bin/_tachyon-tool.js` on every managed op. A git pre-commit hook invokes the shim,
 * which execs the trust-checked absolute Node on THIS file. The workspace root is derived from its own on-disk
 * location (`.tachyon/bin/_tachyon-tool.js` → `../..`).
 */

import path from "node:path";
import { runLauncher } from "./plugins/toolLauncher.js";

const workspaceRoot = path.resolve(__dirname, "..", "..");
process.exit(runLauncher(process.argv.slice(2), { workspaceRoot }));
