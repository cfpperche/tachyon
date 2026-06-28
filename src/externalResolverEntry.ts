/**
 * spec 285 — the standalone EXTERNAL-tool resolver entry. Bundled (no `vscode`) to `dist/external-resolver.cjs` and
 * copied to `<workspace>/.tachyon/bin/_tachyon-external.js` on every managed op. A plugin's skill invokes the shim
 * with no VS Code running, so it must be self-contained. Sibling of `dataResolverEntry.ts`.
 */

import path from "node:path";
import { runExternalResolver } from "./plugins/externalTool.js";

const workspaceRoot = path.resolve(__dirname, "..", "..");
process.exit(runExternalResolver(process.argv.slice(2), { workspaceRoot }));
