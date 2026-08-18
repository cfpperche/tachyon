import os from "node:os";
import path from "node:path";
import { useGlobalSettingsHome } from "@tachyon/engine/config/globalSettings.js";

/**
 * t-7a7ddf — the product no longer reads TACHYON_GLOBAL_SETTINGS_HOME. The suite still must not
 * touch the developer's real ~/.tachyon/settings.json, so the harness points the process-wide
 * store at the disposable home through the existing seam.
 */
const home = process.env.TACHYON_GLOBAL_SETTINGS_HOME?.trim()
  || path.join(os.tmpdir(), "tachyon-vitest-no-global-settings");
useGlobalSettingsHome(home);
