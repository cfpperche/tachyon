import path from "node:path";
import { workspaceRoot } from "../../helpers/repositorySourceScan.js";

export const EXTENSION_ROOT = workspaceRoot("tachyon");
export const EXTENSION_WEBVIEW_DIST = path.join(EXTENSION_ROOT, "dist", "webview");
